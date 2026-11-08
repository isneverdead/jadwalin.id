import { schema } from "@jadwalin/db";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { StorageAdapter } from "./storage";

export interface CheckResult {
  ok: boolean;
  /** Umur hasil terakhir yang berhasil (detik) untuk pekerjaan latar. */
  ageSeconds?: number;
  state?: "belum-pernah" | "basi" | "gagal-terakhir" | "jam-salah";
}

export interface Readiness {
  status: "ok" | "degraded";
  checks: Record<string, CheckResult>;
}

export const HEARTBEAT_MAX_AGE_S = 180;
export const BACKUP_MAX_AGE_S = 30 * 3600;
export const BACKUP_VERIFY_MAX_AGE_S = 36 * 3600;
/** Stempel waktu di masa depan lebih dari ini = jam tak sinkron: jangan dianggap sehat (menyembunyikan worker yang mati). */
export const MAX_CLOCK_SKEW_S = 300;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

function jobCheck(row: { lastOkAt: Date | null; lastFailedAt: Date | null } | undefined, maxAgeS: number, now: Date): CheckResult {
  if (!row?.lastOkAt) return { ok: false, state: "belum-pernah" };
  const age = Math.round((now.getTime() - row.lastOkAt.getTime()) / 1000);
  if (age < -MAX_CLOCK_SKEW_S) return { ok: false, ageSeconds: age, state: "jam-salah" };
  if (row.lastFailedAt && row.lastFailedAt > row.lastOkAt) return { ok: false, ageSeconds: age, state: "gagal-terakhir" };
  return age > maxAgeS ? { ok: false, ageSeconds: age, state: "basi" } : { ok: true, ageSeconds: age };
}

/**
 * Kesiapan layanan untuk pemantau uptime. Hanya mengembalikan boolean/umur (tanpa pesan galat atau nama host):
 * detail galat dicatat di log server, bukan dikirim ke penelepon yang tak terautentikasi.
 */
export async function checkReadiness(opts: { pool: pg.Pool; storage?: StorageAdapter | null; backupExpected?: boolean; now?: Date; onError?: (check: string, error: unknown) => void }): Promise<Readiness> {
  const now = opts.now ?? new Date();
  const checks: Record<string, CheckResult> = {};
  const fail = (name: string, error: unknown) => {
    checks[name] = { ok: false };
    opts.onError?.(name, error);
  };

  try {
    await withTimeout(opts.pool.query("SELECT 1"), 2500);
    checks.db = { ok: true };
  } catch (e) {
    fail("db", e);
  }

  if (opts.storage) {
    try {
      await withTimeout(opts.storage.head("__readiness-probe__"), 3000);
      checks.storage = { ok: true };
    } catch (e) {
      fail("storage", e);
    }
  }

  if (checks.db?.ok) {
    try {
      const names = ["worker_heartbeat", "backup", "backup_verify"];
      const rows = await withTimeout(drizzle(opts.pool, { schema }).select().from(schema.jobStatus).where(inArray(schema.jobStatus.job, names)), 2500);
      const by = new Map(rows.map((r) => [r.job, r]));
      checks.worker = jobCheck(by.get("worker_heartbeat"), HEARTBEAT_MAX_AGE_S, now);
      if (opts.backupExpected) {
        checks.backup = jobCheck(by.get("backup"), BACKUP_MAX_AGE_S, now);
        checks.backup_verify = jobCheck(by.get("backup_verify"), BACKUP_VERIFY_MAX_AGE_S, now);
      }
    } catch (e) {
      fail("worker", e);
    }
  }
  return { status: Object.values(checks).every((c) => c.ok) ? "ok" : "degraded", checks };
}
