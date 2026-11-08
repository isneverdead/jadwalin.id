import { migrateUp } from "@jadwalin/db/migrate";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "../src/backup/backup";
import { pruneBackupsJob, runBackupJob, verifyBackupJob } from "../src/backup/jobs";
import { withDatabase } from "../src/backup/pg";
import { listManifests, restoreAndVerify } from "../src/backup/restore";
import { selectForDeletion } from "../src/backup/retention";
import { BackupStore } from "../src/backup/store";

const PASS = "frasa-backup-uji-yang-cukup-panjang-1234567";
const url = process.env.DATABASE_URL;
const s3 = { endpoint: process.env.S3_ENDPOINT, accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY };
const haveS3 = Boolean(s3.endpoint && s3.accessKeyId && s3.secretAccessKey);
const sfx = Math.random().toString(36).slice(2, 8);

describe("retensi backup (murni)", () => {
  const mk = (iso: string) => ({ key: iso, createdAt: new Date(iso) });
  it("menyimpan terbaru per hari/minggu/bulan dan membuang sisanya; yang terbaru selalu aman", () => {
    const now = new Date("2026-11-30T12:00:00Z");
    const all = [];
    // 120 hari backup, dua per hari
    for (let d = 0; d < 120; d++) for (const h of [2, 14]) all.push(mk(new Date(now.getTime() - d * 86_400_000 - (12 - h) * 3_600_000).toISOString()));
    const del = new Set(selectForDeletion(all, now));
    const kept = all.filter((b) => !del.has(b.key));
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.length).toBeLessThan(all.length / 4);
    const newest = [...all].sort((a, b) => b.key.localeCompare(a.key))[0]!;
    expect(del.has(newest.key)).toBe(false);
    // 7 hari terakhir: tepat satu per hari yang dipertahankan
    const lastWeek = kept.filter((b) => b.createdAt.getTime() > now.getTime() - 7 * 86_400_000);
    expect(new Set(lastWeek.map((b) => b.key.slice(0, 10))).size).toBe(lastWeek.length);
    expect(lastWeek.length).toBeGreaterThanOrEqual(6);
  });
  it("satu backup saja tidak pernah dihapus; daftar kosong aman", () => {
    expect(selectForDeletion([mk("2026-01-01T00:00:00Z")], new Date())).toEqual([]);
    expect(selectForDeletion([], new Date())).toEqual([]);
  });
});

describe.skipIf(!url || !haveS3)("backup → restore → verifikasi (Postgres + S3 asli)", () => {
  const srcName = `jadwalin_bk_src_${sfx}`;
  const prefix = `uji-${sfx}/`;
  let admin: pg.Pool;
  let srcUrl: string;
  let store: BackupStore;
  const cfg = () => ({ databaseUrl: srcUrl, passphrase: PASS, store, prefix, pgBinDir: process.env.PG_BIN_DIR });
  const dbExists = async (name: string) => ((await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name])).rowCount ?? 0) > 0;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 2 });
    await admin.query(`CREATE DATABASE "${srcName}"`);
    srcUrl = withDatabase(url!, srcName);
    await migrateUp(srcUrl);
    const src = new pg.Pool({ connectionString: srcUrl });
    const owner = (await src.query(`INSERT INTO users (email, name, email_verified) VALUES ('pemilik@bk.local', 'Pemilik Backup', true) RETURNING id`)).rows[0].id;
    const ws = (await src.query(`INSERT INTO workspaces (slug, name, owner_user_id) VALUES ('praktik-backup', 'Praktik Backup', $1) RETURNING id`, [owner])).rows[0].id;
    await src.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [ws, owner]);
    const client = (await src.query(`INSERT INTO workspace_clients (workspace_id, name, email) VALUES ($1, 'Klien Backup', 'klien@bk.local') RETURNING id`, [ws])).rows[0].id;
    for (let i = 1; i <= 5; i++) await src.query(`INSERT INTO tickets (workspace_id, number, title, client_id) VALUES ($1, $2, $3, $4)`, [ws, i, `Tiket backup ${i} — é汉字`, client]);
    await src.query(`INSERT INTO audit_log (workspace_id, action, entity_type, entity_id) VALUES ($1, 'uji.backup', 'x', 'x')`, [ws]);
    await src.end();
    store = new BackupStore({ endpoint: s3.endpoint, region: "auto", bucket: "jadwalin-backup-uji", accessKeyId: s3.accessKeyId!, secretAccessKey: s3.secretAccessKey!, forcePathStyle: true });
    await store.ensureBucket();
  });
  afterAll(async () => {
    for (const o of await store.list(prefix)) await store.delete(o.key);
    await admin.query(`DROP DATABASE IF EXISTS "${srcName}" WITH (FORCE)`);
    await admin.end();
  });

  it("alur lengkap: backup terenkripsi → restore ke database sementara → SEMUA cek lolos → database sementara dihapus", async () => {
    const manifest = await runBackup(cfg());
    expect(manifest.counts.tickets).toBe(5);
    expect(manifest.migrationCount).toBeGreaterThan(15);
    expect(manifest.key.startsWith(prefix)).toBe(true);

    // objek di penyimpanan terenkripsi: tidak memuat teks apa pun dari data
    const obj = await store.get(manifest.key);
    const chunks: Buffer[] = [];
    for await (const c of obj) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    expect(raw.length).toBe(manifest.sizeBytes);
    expect(raw.includes(Buffer.from("Praktik Backup"))).toBe(false);
    expect(raw.includes(Buffer.from("PGDMP"))).toBe(false);

    const before = (await admin.query(`SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'jadwalin_restore_%'`)).rows[0].n;
    const report = await restoreAndVerify({ ...cfg() });
    expect(report.checks.map((c) => `${c.ok ? "OK " : "GAGAL "}${c.name}: ${c.detail}`).join("\n")).toBeTruthy();
    expect(report.checks.filter((c) => !c.ok), JSON.stringify(report.checks.filter((c) => !c.ok))).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(9);
    const after = (await admin.query(`SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'jadwalin_restore_%'`)).rows[0].n;
    expect(after).toBe(before); // tidak ada sisa database sementara
    expect((await listManifests(store, prefix))[0]!.key).toBe(manifest.key);
  });

  it("data hasil pemulihan benar-benar sama (termasuk karakter non-ASCII), bukan sekadar jumlahnya", async () => {
    const name = `jadwalin_restore_keep_${sfx}`;
    try {
      const report = await restoreAndVerify({ ...cfg(), keepDatabaseAs: name });
      expect(report.ok).toBe(true);
      const restored = new pg.Pool({ connectionString: withDatabase(url!, name) });
      try {
        const rows = (await restored.query(`SELECT title FROM tickets ORDER BY number`)).rows.map((r) => r.title);
        expect(rows).toEqual([1, 2, 3, 4, 5].map((i) => `Tiket backup ${i} — é汉字`));
        expect((await restored.query(`SELECT email FROM users`)).rows[0].email).toBe("pemilik@bk.local");
      } finally {
        await restored.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); // bersih walau asersi gagal
    }
  });

  it("objek yang diubah satu byte di penyimpanan ditolak (bukan dipulihkan diam-diam) dan tak ada sisa database", async () => {
    const m = (await listManifests(store, prefix))[0]!;
    const original: Buffer[] = [];
    for await (const c of await store.get(m.key)) original.push(c as Buffer);
    const bad = Buffer.concat(original);
    bad[Math.floor(bad.length / 2)] = bad[Math.floor(bad.length / 2)]! ^ 0x01;
    await store.putBuffer(m.key, bad, "application/octet-stream");
    try {
      const before = (await admin.query(`SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'jadwalin_restore_%'`)).rows[0].n;
      const report = await restoreAndVerify({ ...cfg(), key: m.key });
      expect(report.ok).toBe(false);
      expect(report.checks.some((c) => !c.ok && /dekripsi|hash/i.test(c.name))).toBe(true);
      expect((await admin.query(`SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'jadwalin_restore_%'`)).rows[0].n).toBe(before);
    } finally {
      await store.putBuffer(m.key, Buffer.concat(original), "application/octet-stream");
    }
  });

  it("frasa sandi salah, hash manifest yang tidak cocok, dan klaim jumlah baris berlebih semuanya GAGAL", async () => {
    const m = (await listManifests(store, prefix))[0]!;
    const wrongPass = await restoreAndVerify({ ...cfg(), passphrase: "frasa-lain-yang-juga-cukup-panjang-99999999" });
    expect(wrongPass.ok).toBe(false);

    const manifestKey = `${m.key}.json`;
    const goodJson = await store.getText(manifestKey);
    try {
      await store.putBuffer(manifestKey, JSON.stringify({ ...m, sha256: "0".repeat(64) }), "application/json");
      const badHash = await restoreAndVerify({ ...cfg(), key: m.key });
      expect(badHash.ok).toBe(false);
      expect(badHash.checks.find((c) => /hash/i.test(c.name))!.ok).toBe(false);

      await store.putBuffer(manifestKey, JSON.stringify({ ...m, counts: { ...m.counts, tickets: 999 } }), "application/json");
      const missing = await restoreAndVerify({ ...cfg(), key: m.key });
      expect(missing.ok).toBe(false);
      expect(missing.checks.find((c) => /jumlah baris/i.test(c.name))!.detail).toContain("tickets 5<999");
    } finally {
      await store.putBuffer(manifestKey, goodJson, "application/json");
    }
  });

  it("pekerjaan terjadwal: backup + uji restore + retensi tercatat di job_status; kegagalan uji restore tercatat dan dilempar", async () => {
    const pool = new pg.Pool({ connectionString: srcUrl });
    const env = { s3: { endpoint: s3.endpoint, region: "auto", bucket: "jadwalin-backup-uji", accessKeyId: s3.accessKeyId!, secretAccessKey: s3.secretAccessKey!, forcePathStyle: true }, passphrase: PASS, pgBinDir: process.env.PG_BIN_DIR };
    // job_status ada di database sumber (hasil migrasi); jobs memakai prefiks bawaan `db/`, jadi bersihkan setelahnya.
    const ctx = { pool, databaseUrl: srcUrl, env };
    const store2 = new BackupStore({ endpoint: s3.endpoint, region: "auto", bucket: "jadwalin-backup-uji", accessKeyId: s3.accessKeyId!, secretAccessKey: s3.secretAccessKey!, forcePathStyle: true });
    const status = async (job: string) => (await pool.query(`SELECT last_ok_at, last_failed_at, last_error FROM job_status WHERE job = $1`, [job])).rows[0];
    try {
      const b = await runBackupJob(ctx);
      expect(String(b.key).startsWith("db/")).toBe(true);
      expect((await status("backup")).last_ok_at).not.toBeNull();

      const v = await verifyBackupJob(ctx);
      expect(v.checks).toBeGreaterThanOrEqual(9);
      expect((await status("backup_verify")).last_ok_at).not.toBeNull();

      const p = await pruneBackupsJob(ctx);
      expect(p.kept).toBeGreaterThanOrEqual(1);

      await expect(verifyBackupJob({ ...ctx, env: { ...env, passphrase: "frasa-lain-yang-juga-cukup-panjang-00000000" } })).rejects.toThrow(/Uji restore GAGAL/);
      const failed = await status("backup_verify");
      expect(failed.last_failed_at).not.toBeNull();
      expect(failed.last_error).toMatch(/Uji restore GAGAL/);
    } finally {
      for (const o of await store2.list("db/")) await store2.delete(o.key);
      await pool.end();
    }
  });

  it("pg_dump yang gagal di tengah jalan: backup dinyatakan gagal, objek parsial dihapus, tanpa manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fakepg-"));
    const script = join(dir, "pg_dump");
    writeFileSync(script, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.9"; exit 0; fi\nprintf 'PGDMP-sebagian-data'\necho "koneksi putus" >&2\nexit 3\n`);
    chmodSync(script, 0o755);
    const failPrefix = `${prefix}gagal/`;
    await expect(runBackup({ ...cfg(), prefix: failPrefix, pgBinDir: dir })).rejects.toThrow(/pg_dump gagal \(kode 3\).*koneksi putus/);
    expect(await store.list(failPrefix)).toEqual([]); // tak ada objek maupun manifest yang tertinggal
  });
});
