import { withTenant } from "@jadwalin/db";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type pg from "pg";
import { AppError } from "./errors";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Kunci pembatas tidak boleh memuat data pribadi: hash-kan identitas (IP, email) sebelum dipakai. */
export function rateKey(scope: string, identity: string): string {
  return `${scope}:${createHash("sha256").update(identity.toLowerCase()).digest("hex").slice(0, 32)}`;
}

/**
 * Kunci penerima email yang tahan trik alias: huruf kecil, buang "+tag", dan (Gmail) abaikan titik. Dipakai agar
 * `korban+1@gmail.com`, `k.orban@gmail.com`, dan `korban@gmail.com` dihitung sebagai satu penerima.
 */
export function normalizeRecipientKey(email: string): string {
  const [rawLocal = "", rawDomain = ""] = email.trim().toLowerCase().split("@");
  const domain = rawDomain === "googlemail.com" ? "gmail.com" : rawDomain;
  let local = rawLocal.split("+")[0] ?? rawLocal;
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

/**
 * Pembatas laju jendela-tetap yang tersimpan di DB (berlaku lintas instance). Dicatat di transaksi TERSENDIRI
 * sehingga percobaan yang gagal pun tetap dihitung. Melebihi batas → AppError('rate_limited').
 */
export async function consumeRateLimit(pool: pg.Pool, key: string, opts: { limit: number; windowSec: number; now?: Date; message?: string }): Promise<number> {
  const now = opts.now ?? new Date();
  const count = await withTenant(pool, { userId: NIL_UUID }, async (db) => {
    // Batas jendela dihitung di JS (tanpa make_interval) agar tipe parameter tidak ambigu.
    const nowIso = now.toISOString();
    const cutoff = new Date(now.getTime() - opts.windowSec * 1000).toISOString();
    const res = await db.execute<{ count: number }>(sql`
      INSERT INTO rate_counters (key, count, window_start) VALUES (${key}, 1, ${nowIso}::timestamptz)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN rate_counters.window_start <= ${cutoff}::timestamptz THEN 1 ELSE rate_counters.count + 1 END,
        window_start = CASE WHEN rate_counters.window_start <= ${cutoff}::timestamptz THEN ${nowIso}::timestamptz ELSE rate_counters.window_start END
      RETURNING count`);
    return res.rows[0]!.count;
  });
  if (count > opts.limit) throw new AppError("rate_limited", opts.message ?? "Terlalu banyak permintaan. Coba lagi nanti.");
  return count;
}

/** Worker: hapus penghitung yang jendelanya sudah lewat jauh. */
export async function cleanupRateCounters(pool: pg.Pool, olderThanMs = 2 * 24 * 3600_000, now = new Date()): Promise<number> {
  const { withWorker } = await import("@jadwalin/db");
  const cutoff = new Date(now.getTime() - olderThanMs);
  return withWorker(pool, async (db) => {
    const res = await db.execute(sql`DELETE FROM rate_counters WHERE window_start < ${cutoff.toISOString()}::timestamptz`);
    return res.rowCount ?? 0;
  });
}
