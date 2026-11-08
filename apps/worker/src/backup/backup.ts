import { createHash } from "node:crypto";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { createEncryptStream } from "./crypto";
import { assertClientMatchesServer, pgBin, pgEnv, spawnPg } from "./pg";
import type { BackupStore } from "./store";

export interface Manifest {
  version: 1;
  key: string;
  createdAt: string;
  sizeBytes: number;
  /** SHA-256 dari objek terenkripsi di penyimpanan. */
  sha256: string;
  pgDump: string;
  serverVersion: string;
  migrationCount: number;
  policyCount: number;
  tableCount: number;
  /** Jumlah baris tabel kunci SEBELUM dump (hanya bertambah/tetap; pemulihan harus memuat sekurangnya sebanyak ini). */
  counts: Record<string, number>;
}

export const BACKUP_PREFIX = "db/";
export const COUNT_TABLES = ["users", "workspaces", "workspace_members", "workspace_clients", "bookings", "tickets", "ticket_events", "ticket_comments", "files", "audit_log"] as const;

export interface BackupConfig {
  databaseUrl: string;
  passphrase: string;
  store: BackupStore;
  pgBinDir?: string;
  now?: Date;
  /** Awalan kunci objek (default `db/`); tes memakai awalan unik. */
  prefix?: string;
}

export interface DbStats {
  counts: Record<string, number>;
  policyCount: number;
  tableCount: number;
  migrationCount: number;
  serverVersion: string;
}

export async function collectStats(pool: pg.Pool): Promise<DbStats> {
  const counts: Record<string, number> = {};
  for (const t of COUNT_TABLES) counts[t] = Number((await pool.query(`SELECT count(*)::bigint AS n FROM ${t}`)).rows[0].n);
  const one = async (sql: string) => Number((await pool.query(sql)).rows[0].n);
  return {
    counts,
    policyCount: await one(`SELECT count(*)::int AS n FROM pg_policy`),
    tableCount: await one(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`),
    migrationCount: await one(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`),
    serverVersion: String((await pool.query(`SHOW server_version`)).rows[0].server_version),
  };
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Satu backup logis lengkap (pg_dump -Fc, termasuk hak akses/GRANT) → enkripsi → penyimpanan, lalu manifest. */
export async function runBackup(cfg: BackupConfig): Promise<Manifest> {
  const now = cfg.now ?? new Date();
  const key = `${cfg.prefix ?? BACKUP_PREFIX}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/jadwalin-${stamp(now)}.dump.enc`;
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 1 });
  try {
    const stats = await collectStats(pool);
    await assertClientMatchesServer(pgBin("pg_dump", cfg.pgBinDir), Number(stats.serverVersion.split(".")[0]));

    const dump = spawnPg(pgBin("pg_dump", cfg.pgBinDir), ["--format=custom", "--no-owner", "--no-comments"], pgEnv(cfg.databaseUrl));
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    const body = new PassThrough();
    const upload = cfg.store.put(key, body);
    const piped = pipeline(dump.child.stdout!, createEncryptStream(cfg.passphrase), meter, body);

    const [dumpDone, pipeResult, uploadResult] = await Promise.allSettled([dump.done, piped, upload]);
    if (dumpDone.status === "rejected") throw dumpDone.reason;
    const exit = dumpDone.value;
    if (exit.code === 0) {
      if (pipeResult.status === "rejected") throw pipeResult.reason;
      if (uploadResult.status === "rejected") throw uploadResult.reason;
    }
    if (exit.code !== 0) {
      // pg_dump gagal di tengah jalan: objek yang terunggah sebagian tampak sah (potongan terakhir tetap ditulis). Hapus.
      await cfg.store.delete(key).catch(() => undefined);
      throw new Error(`pg_dump gagal (kode ${exit.code}): ${exit.stderr.trim().slice(0, 500)}`);
    }
    const manifest: Manifest = {
      version: 1,
      key,
      createdAt: now.toISOString(),
      sizeBytes: size,
      sha256: hash.digest("hex"),
      pgDump: await pgDumpVersion(cfg),
      serverVersion: stats.serverVersion,
      migrationCount: stats.migrationCount,
      policyCount: stats.policyCount,
      tableCount: stats.tableCount,
      counts: stats.counts,
    };
    await cfg.store.putBuffer(`${key}.json`, JSON.stringify(manifest, null, 2), "application/json");
    return manifest;
  } finally {
    await pool.end();
  }
}

async function pgDumpVersion(cfg: BackupConfig): Promise<string> {
  const v = spawnPg(pgBin("pg_dump", cfg.pgBinDir), ["--version"], process.env);
  const out: Buffer[] = [];
  v.child.stdout!.on("data", (d: Buffer) => out.push(d));
  await v.done;
  return Buffer.concat(out).toString().trim();
}
