import { asWorker, withTenant, schema, type Db } from "@jadwalin/db";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";

/**
 * Klaim catatan klien TAMU (dan tiketnya) oleh pemilik email yang sudah TERVERIFIKASI. Email terverifikasi adalah bukti
 * kepemilikan alamat; tanpa itu tak ada yang diklaim. Dijalankan lewat role worker dengan hak sempit: hanya mengisi
 * `user_id` pada klien tanpa pemilik dan `requester_user_id` pada tiket tanpa pemilik. Idempoten.
 */
export async function claimGuestRecordsIn(db: Db, userId: string): Promise<{ clients: number; tickets: number }> {
  return asWorker(db, async (w) => {
    const [me] = await w.select({ email: schema.users.email, verified: schema.users.emailVerified }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!me?.verified) return { clients: 0, tickets: 0 };
    const email = me.email.toLowerCase();
    const claimed = await w.execute<{ id: string }>(sql`
      UPDATE workspace_clients c SET user_id = ${userId}
      WHERE c.user_id IS NULL AND lower(c.email) = ${email}
        AND NOT EXISTS (SELECT 1 FROM workspace_clients c2 WHERE c2.workspace_id = c.workspace_id AND c2.user_id = ${userId})
      RETURNING c.id`);
    const ids = claimed.rows.map((r) => r.id);
    if (ids.length === 0) return { clients: 0, tickets: 0 };
    const tickets = await w.execute(sql`UPDATE tickets SET requester_user_id = ${userId} WHERE requester_user_id IS NULL AND client_id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`);
    return { clients: ids.length, tickets: tickets.rowCount ?? 0 };
  });
}

export async function claimGuestRecords(pool: pg.Pool, userId: string) {
  return withTenant(pool, { userId }, (db) => claimGuestRecordsIn(db, userId));
}
