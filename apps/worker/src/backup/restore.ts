import { createHash, randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { BACKUP_PREFIX, collectStats, COUNT_TABLES, type Manifest } from "./backup";
import { createDecryptStream } from "./crypto";
import { assertClientMatchesServer, pgBin, pgEnv, spawnPg, withDatabase } from "./pg";
import type { BackupStore } from "./store";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  manifest: Manifest;
  durationMs: number;
  checks: Check[];
}

export interface RestoreConfig {
  databaseUrl: string; // admin (boleh membuat database) di cluster TARGET
  passphrase: string;
  store: BackupStore;
  pgBinDir?: string;
  /** Kunci objek (.dump.enc); kosong = backup terbaru. */
  key?: string;
  /** Pertahankan database hasil pemulihan (untuk pemulihan sungguhan); default: dihapus setelah verifikasi. */
  keepDatabaseAs?: string;
  prefix?: string;
}

export async function listManifests(store: BackupStore, prefix = BACKUP_PREFIX): Promise<Manifest[]> {
  const objs = (await store.list(prefix)).filter((o) => o.key.endsWith(".dump.enc.json"));
  const manifests: Manifest[] = [];
  for (const o of objs) manifests.push(JSON.parse(await store.getText(o.key)) as Manifest);
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Prasyarat pemulihan ke klaster baru: role aplikasi harus ada (role bersifat global klaster, bukan bagian dump). */
async function ensureRoles(admin: pg.Pool): Promise<void> {
  for (const role of ["jadwalin_app", "jadwalin_worker"]) {
    const r = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
    if (r.rowCount === 0) await admin.query(`CREATE ROLE ${role} NOLOGIN`);
  }
}

/**
 * Pulihkan backup ke database SEMENTARA, verifikasi isinya, lalu hapus. Inilah "uji restore": backup yang tak pernah
 * dipulihkan hanyalah harapan. Semua cek dilaporkan; ok hanya bila semuanya lolos.
 */
export async function restoreAndVerify(cfg: RestoreConfig): Promise<VerifyReport> {
  const started = Date.now();
  const manifest = cfg.key
    ? (JSON.parse(await cfg.store.getText(`${cfg.key}.json`)) as Manifest)
    : (await listManifests(cfg.store, cfg.prefix))[0];
  if (!manifest) throw new Error("Tidak ada backup untuk diverifikasi");

  const target = cfg.keepDatabaseAs ?? `jadwalin_restore_${Date.now()}_${randomBytes(3).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: cfg.databaseUrl, max: 1 });
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let scratch: pg.Pool | null = null;
  try {
    await assertClientMatchesServer(pgBin("pg_restore", cfg.pgBinDir), Number((await admin.query(`SHOW server_version_num`)).rows[0].server_version_num) / 10000 | 0);
    await ensureRoles(admin);
    await admin.query(`CREATE DATABASE "${target}"`);

    // Unduh → verifikasi hash objek terenkripsi → dekripsi ber-autentikasi → pg_restore (semua lewat aliran).
    const hash = createHash("sha256");
    const meter = new Transform({ transform(c: Buffer, _e, cb) { hash.update(c); cb(null, c); } });
    const restore = spawnPg(pgBin("pg_restore", cfg.pgBinDir), ["--no-owner", "--exit-on-error", `--dbname=${target}`], pgEnv(cfg.databaseUrl, target));
    // pg_restore menutup stdin lebih awal bila galat: abaikan EPIPE agar galat aslinya yang dilaporkan.
    restore.child.stdin!.on("error", () => undefined);
    let streamError: Error | null = null;
    await pipeline(await cfg.store.get(manifest.key), meter, createDecryptStream(cfg.passphrase), restore.child.stdin!).catch((e: Error) => { streamError = e; });
    const exit = await restore.done;
    add("hash objek terenkripsi cocok dengan manifest", hash.digest("hex") === manifest.sha256, `ukuran manifest ${manifest.sizeBytes} byte`);
    add("dekripsi ber-autentikasi dan pg_restore sukses", !streamError && exit.code === 0, streamError ? (streamError as Error).message : exit.code === 0 ? "ok" : `pg_restore kode ${exit.code}: ${exit.stderr.trim().slice(0, 300)}`);
    if (streamError || exit.code !== 0) return { ok: false, manifest, durationMs: Date.now() - started, checks };

    scratch = new pg.Pool({ connectionString: withDatabase(cfg.databaseUrl, target), max: 2 });
    const stats = await collectStats(scratch);

    add("jumlah migrasi sama", stats.migrationCount === manifest.migrationCount, `${stats.migrationCount} dari ${manifest.migrationCount}`);
    add("jumlah tabel sama", stats.tableCount === manifest.tableCount, `${stats.tableCount} dari ${manifest.tableCount}`);
    add("jumlah policy RLS sama", stats.policyCount === manifest.policyCount, `${stats.policyCount} dari ${manifest.policyCount}`);
    const shortfall = COUNT_TABLES.filter((t) => (stats.counts[t] ?? 0) < (manifest.counts[t] ?? 0));
    add("jumlah baris tabel kunci tidak kurang dari saat backup", shortfall.length === 0, shortfall.length ? `kurang: ${shortfall.map((t) => `${t} ${stats.counts[t]}<${manifest.counts[t]}`).join(", ")}` : COUNT_TABLES.map((t) => `${t}=${stats.counts[t]}`).join(" "));

    const rls = await scratch.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped)
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`);
    add("RLS aktif dan FORCE di semua tabel tenant", rls.rowCount === 0, rls.rowCount ? `tanpa RLS: ${rls.rows.map((r) => r.relname).join(", ")}` : "ok");

    const orphan = await scratch.query(`SELECT count(*)::int AS n FROM tickets t LEFT JOIN workspaces w ON w.id = t.workspace_id WHERE w.id IS NULL`);
    add("integritas referensi (tiket tanpa workspace = 0)", orphan.rows[0].n === 0, `${orphan.rows[0].n} yatim`);

    const guard = await scratch.query(`SELECT (SELECT count(*) FROM pg_constraint WHERE conname = 'bookings_no_overlap')::int AS excl, (SELECT count(*) FROM pg_extension WHERE extname = 'btree_gist')::int AS ext`);
    add("constraint anti-bentrok dan ekstensi btree_gist ada", guard.rows[0].excl === 1 && guard.rows[0].ext === 1, JSON.stringify(guard.rows[0]));

    // Fungsional: sebagai role aplikasi TANPA konteks, RLS harus menyembunyikan semua baris tenant.
    const client = await scratch.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE jadwalin_app");
      const visible = await client.query(`SELECT (SELECT count(*) FROM tickets) + (SELECT count(*) FROM bookings) + (SELECT count(*) FROM workspace_members) AS n`);
      add("role aplikasi tanpa konteks tidak melihat data tenant (RLS bekerja)", Number(visible.rows[0].n) === 0, `${visible.rows[0].n} baris terlihat`);
    } catch (e) {
      add("role aplikasi tanpa konteks tidak melihat data tenant (RLS bekerja)", false, (e as Error).message);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    return { ok: checks.every((c) => c.ok), manifest, durationMs: Date.now() - started, checks };
  } finally {
    await scratch?.end().catch(() => undefined);
    if (!cfg.keepDatabaseAs) await admin.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
}
