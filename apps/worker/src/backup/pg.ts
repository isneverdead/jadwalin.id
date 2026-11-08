import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/** Variabel lingkungan libpq dari URL (kata sandi lewat env, bukan argumen, agar tak terlihat di `ps`). */
export function pgEnv(databaseUrl: string, dbName?: string): NodeJS.ProcessEnv {
  const u = new URL(databaseUrl);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: dbName ?? u.pathname.replace(/^\//, ""),
  };
}

export function withDatabase(databaseUrl: string, dbName: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export function pgBin(name: "pg_dump" | "pg_restore", dir?: string): string {
  return dir ? join(dir, name) : name;
}

export interface Spawned {
  child: ChildProcess;
  /** Selesai dengan kode keluar; stderr terkumpul (dipangkas) untuk pesan galat. */
  done: Promise<{ code: number | null; stderr: string }>;
}

export function spawnPg(bin: string, args: string[], env: NodeJS.ProcessEnv): Spawned {
  const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => {
    if (stderr.length < 4000) stderr += d.toString();
  });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
  return { child, done };
}

/** Versi mayor klien (`pg_dump --version` → 16). */
export async function clientMajor(bin: string): Promise<number> {
  const v = spawnPg(bin, ["--version"], process.env);
  const out: Buffer[] = [];
  v.child.stdout!.on("data", (d: Buffer) => out.push(d));
  const { code } = await v.done;
  const text = Buffer.concat(out).toString();
  const m = /(\d+)(?:\.\d+)?/.exec(text.replace(/^[^\d]*/, ""));
  if (code !== 0 || !m) throw new Error(`Tidak bisa membaca versi ${bin}`);
  return Number(m[1]);
}

/**
 * Klien dump/restore HARUS semajor dengan server: klien yang lebih baru menulis perintah yang tak dikenal server lama
 * (mis. `SET transaction_timeout`), sehingga backup tampak sukses tetapi GAGAL dipulihkan saat dibutuhkan.
 * Atur PG_BIN_DIR ke direktori klien yang cocok.
 */
export async function assertClientMatchesServer(bin: string, serverMajor: number): Promise<void> {
  const client = await clientMajor(bin);
  if (client !== serverMajor) {
    throw new Error(`Versi ${bin} (${client}) tidak sama dengan versi server PostgreSQL (${serverMajor}). Pasang klien PostgreSQL ${serverMajor} dan atur PG_BIN_DIR ke direktorinya.`);
  }
}
