import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export interface TenantContext {
  userId: string;
  /** Kosong untuk operasi lintas-workspace milik user (daftar workspace, portal klien). */
  workspaceId?: string;
  /** SHA-256 token undangan; hanya untuk membaca satu undangan milik pemegang token. */
  inviteTokenHash?: string;
  /** 'client' = pengguna terdaftar (bukan anggota) yang mengakses data miliknya; 'public' = tamu tanpa akun. Lihat migrasi 0009/0011. */
  actor?: "client" | "public";
  /** SHA-256 token kelola booking: membuka satu booking (dan jenis/workspace-nya) bagi pemegang token. */
  bookingTokenHash?: string;
  /** Slug publik: hanya untuk membaca baris workspace itu (halaman portal). */
  publicSlug?: string;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

/**
 * Satu-satunya pintu akses data tenant (aturan #9): transaksi dengan role `jadwalin_app`
 * (RLS berlaku) dan konteks user/workspace. Tanpa konteks, query tidak melihat baris apa pun.
 */
export async function withTenant<T>(pool: pg.Pool, ctx: TenantContext, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE jadwalin_app");
    await client.query("SELECT set_config('app.user_id', $1, true)", [ctx.userId]);
    if (ctx.workspaceId) await client.query("SELECT set_config('app.workspace_id', $1, true)", [ctx.workspaceId]);
    if (ctx.inviteTokenHash) await client.query("SELECT set_config('app.invite_token_hash', $1, true)", [ctx.inviteTokenHash]);
    if (ctx.actor) await client.query("SELECT set_config('app.actor_kind', $1, true)", [ctx.actor]);
    if (ctx.bookingTokenHash) await client.query("SELECT set_config('app.booking_token_hash', $1, true)", [ctx.bookingTokenHash]);
    if (ctx.publicSlug) await client.query("SELECT set_config('app.public_slug', $1, true)", [ctx.publicSlug]);
    const result = await fn(drizzle(client, { schema }));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Akses lintas-tenant untuk proses latar (apps/worker) dan email sistem: role `jadwalin_worker`
 * yang hanya punya hak pada outbox dan berkas (lihat migrasi 0007). Jangan dipakai dari request pengguna.
 */
export async function withWorker<T>(pool: pg.Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE jadwalin_worker");
    const result = await fn(drizzle(client, { schema }));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Beralih sementara ke role worker DI DALAM transaksi tenant (mis. untuk mengantre email ke staf
 * saat aksi klien), lalu kembali ke jadwalin_app. Konteks (user/workspace/aktor) tetap utuh.
 * Atomik dengan perubahan bisnis: bila transaksi dibatalkan, email ikut batal.
 */
export async function asWorker<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  // Kembali ke role SEBELUMNYA (bukan selalu jadwalin_app): di dalam withWorker (mis. hook pembayaran) role tetap worker.
  const prev = (await db.execute<{ r: string }>(sql`SELECT current_user AS r`)).rows[0]!.r;
  const back = prev === "jadwalin_worker" ? "jadwalin_worker" : "jadwalin_app";
  await db.execute(sql`SET LOCAL ROLE jadwalin_worker`);
  // Bila fn gagal, transaksi sudah ter-abort: jangan menimpa galat aslinya dengan galat pemulihan role.
  const result = await fn(db);
  await db.execute(sql.raw(`SET LOCAL ROLE ${back}`));
  return result;
}
