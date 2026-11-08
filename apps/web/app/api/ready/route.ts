import { checkReadiness, type Readiness } from "@jadwalin/core";
import { getPool, getStorage } from "@/lib/server";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Pemantau sering memukul endpoint ini: hasil dipakai ulang beberapa detik agar tak menjadi beban sendiri.
let cache: { at: number; body: Readiness } | null = null;
const TTL_MS = 5000;

/**
 * Kesiapan: DB, penyimpanan berkas, detak worker, dan kesegaran backup + uji restore. 503 bila ada yang gagal,
 * sehingga pemantau uptime (mis. Better Stack, UptimeRobot) menyalakan alarm. Isinya hanya boolean/umur.
 */
export async function GET() {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    let storage = null;
    try {
      storage = getStorage();
    } catch {
      storage = null; // penyimpanan belum dikonfigurasi di lingkungan ini
    }
    const body = await checkReadiness({
      pool: getPool(),
      storage,
      backupExpected: process.env.BACKUP_ENABLED === "true",
      onError: (check, error) => logger.error({ check, err: error instanceof Error ? error.message : String(error) }, "pemeriksaan kesiapan gagal"),
    });
    cache = { at: Date.now(), body };
  }
  return Response.json(cache.body, { status: cache.body.status === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
