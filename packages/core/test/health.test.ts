import { createPool } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKUP_MAX_AGE_S, checkReadiness, HEARTBEAT_MAX_AGE_S, type StorageAdapter } from "../src";

const url = process.env.DATABASE_URL;
const okStorage: StorageAdapter = { presignUpload: async () => ({ url: "", headers: {}, expiresInSec: 1 }), presignDownload: async () => "", head: async () => null, delete: async () => undefined };
const brokenStorage: StorageAdapter = { ...okStorage, head: async () => { throw new Error("S3 down: secret-host.internal:9000 kredensial salah"); } };

describe.skipIf(!url)("kesiapan layanan (Postgres asli)", () => {
  let pool: pg.Pool;
  const NOW = new Date("2035-06-01T12:00:00Z");
  const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
  const setJob = (job: string, ok: Date | null, failed: Date | null = null) =>
    pool.query(`INSERT INTO job_status (job, last_ok_at, last_failed_at, updated_at) VALUES ($1, $2, $3, now())
                ON CONFLICT (job) DO UPDATE SET last_ok_at = $2, last_failed_at = $3`, [job, ok, failed]);

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
  });
  afterAll(async () => {
    // Baris bertanggal 2035 tidak boleh tertinggal di DB bersama (akan terbaca sebagai detak "sehat" oleh pemeriksaan lain).
    await pool.query(`DELETE FROM job_status WHERE job IN ('worker_heartbeat', 'backup', 'backup_verify')`);
    await pool?.end();
  });

  it("semua sehat → ok; hanya boolean dan umur yang dikembalikan", async () => {
    await setJob("worker_heartbeat", ago(30));
    await setJob("backup", ago(3600));
    await setJob("backup_verify", ago(3600));
    const r = await checkReadiness({ pool, storage: okStorage, backupExpected: true, now: NOW });
    expect(r.status).toBe("ok");
    expect(r.checks).toEqual({ db: { ok: true }, storage: { ok: true }, worker: { ok: true, ageSeconds: 30 }, backup: { ok: true, ageSeconds: 3600 }, backup_verify: { ok: true, ageSeconds: 3600 } });
  });

  it("detak worker basi atau belum pernah ada → degraded", async () => {
    await setJob("worker_heartbeat", ago(HEARTBEAT_MAX_AGE_S + 60));
    let r = await checkReadiness({ pool, storage: okStorage, now: NOW });
    expect(r.status).toBe("degraded");
    expect(r.checks.worker).toMatchObject({ ok: false, state: "basi" });
    await pool.query(`DELETE FROM job_status WHERE job = 'worker_heartbeat'`);
    r = await checkReadiness({ pool, storage: okStorage, now: NOW });
    expect(r.checks.worker).toEqual({ ok: false, state: "belum-pernah" });
  });

  it("stempel waktu di MASA DEPAN (jam salah/data palsu) dianggap tidak sehat, bukan 'segar selamanya'", async () => {
    await setJob("worker_heartbeat", new Date(NOW.getTime() + 3600_000));
    const r = await checkReadiness({ pool, now: NOW });
    expect(r.status).toBe("degraded");
    expect(r.checks.worker).toMatchObject({ ok: false, state: "jam-salah" });
    await setJob("worker_heartbeat", new Date(NOW.getTime() + 60_000)); // selisih jam kecil tetap ditoleransi
    expect((await checkReadiness({ pool, now: NOW })).checks.worker?.ok).toBe(true);
  });

  it("backup basi (>30 jam), belum pernah berjalan, atau terakhir GAGAL → degraded; bila backup tak diharapkan tidak diperiksa", async () => {
    await setJob("worker_heartbeat", ago(10));
    await setJob("backup", ago(BACKUP_MAX_AGE_S + 3600));
    await setJob("backup_verify", ago(100));
    expect((await checkReadiness({ pool, backupExpected: true, now: NOW })).checks.backup).toMatchObject({ ok: false, state: "basi" });
    await setJob("backup", ago(1000), ago(10)); // sempat sukses, tapi percobaan terakhir gagal
    expect((await checkReadiness({ pool, backupExpected: true, now: NOW })).checks.backup).toMatchObject({ ok: false, state: "gagal-terakhir" });
    await pool.query(`DELETE FROM job_status WHERE job = 'backup'`);
    expect((await checkReadiness({ pool, backupExpected: true, now: NOW })).checks.backup).toEqual({ ok: false, state: "belum-pernah" });
    const off = await checkReadiness({ pool, backupExpected: false, now: NOW });
    expect(off.checks.backup).toBeUndefined();
    expect(off.status).toBe("ok");
  });

  it("uji restore terakhir gagal → degraded", async () => {
    await setJob("worker_heartbeat", ago(10));
    await setJob("backup", ago(100));
    await setJob("backup_verify", ago(500), ago(20));
    const r = await checkReadiness({ pool, backupExpected: true, now: NOW });
    expect(r.status).toBe("degraded");
    expect(r.checks.backup_verify).toMatchObject({ ok: false, state: "gagal-terakhir" });
  });

  it("penyimpanan rusak → degraded; detail galat (host, kredensial) TIDAK ada di respons, hanya di callback log", async () => {
    await setJob("worker_heartbeat", ago(10));
    const logged: string[] = [];
    const r = await checkReadiness({ pool, storage: brokenStorage, now: NOW, onError: (c, e) => logged.push(`${c}:${(e as Error).message}`) });
    expect(r.status).toBe("degraded");
    expect(r.checks.storage).toEqual({ ok: false });
    expect(JSON.stringify(r)).not.toMatch(/secret-host|kredensial|S3 down/);
    expect(logged.join()).toContain("secret-host.internal");
  });

  it("database mati → degraded dengan cepat (tidak menggantung) dan tanpa pemeriksaan yang bergantung DB", async () => {
    const dead = new pg.Pool({ connectionString: "postgres://x:y@127.0.0.1:1/none", connectionTimeoutMillis: 800 });
    const t0 = Date.now();
    const r = await checkReadiness({ pool: dead, storage: okStorage, now: NOW });
    await dead.end();
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.status).toBe("degraded");
    expect(r.checks.db).toEqual({ ok: false });
    expect(r.checks.worker).toBeUndefined();
  });
});
