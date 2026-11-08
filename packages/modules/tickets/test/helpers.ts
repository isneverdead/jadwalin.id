import { acceptInvitation, inviteMember, S3Storage, type Actor, type Role } from "@jadwalin/core";
import { withWorker } from "@jadwalin/db";
import { sql } from "drizzle-orm";
import type pg from "pg";

export async function tokenFromOutbox(pool: pg.Pool, email: string): Promise<string> {
  const rows = await withWorker(pool, (db) =>
    db.execute<{ payload: { url: string } }>(sql`SELECT payload FROM notification_outbox WHERE recipient = ${email.toLowerCase()} AND template = 'workspace_invite' ORDER BY created_at DESC LIMIT 1`),
  );
  const url = rows.rows[0]?.payload?.url;
  if (!url) throw new Error(`Tidak ada email undangan untuk ${email}`);
  return url.split("/undangan/")[1]!;
}

export async function inviteAndAccept(pool: pg.Pool, actor: Actor, who: { userId: string; email: string; role: Exclude<Role, "owner"> }) {
  await inviteMember(pool, actor, { email: who.email, role: who.role }, { baseUrl: "http://test.local" });
  return acceptInvitation(pool, who.userId, await tokenFromOutbox(pool, who.email));
}

export async function mkUser(pool: pg.Pool, label: string, sfx: string, verified = true): Promise<{ id: string; email: string }> {
  const email = `${label}-${sfx}@tiket.local`;
  const r = await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, $2, $3) RETURNING id`, [email, label, verified]);
  return { id: r.rows[0].id, email };
}

export function testStorage(): S3Storage | null {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null;
  return new S3Storage({ endpoint: S3_ENDPOINT, region: "auto", bucket: S3_BUCKET, accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY, forcePathStyle: true });
}

/** Email notifikasi tiket yang antre untuk satu penerima (dibaca langsung sebagai superuser tes). */
export async function outboxFor(pool: pg.Pool, to: string) {
  const r = await pool.query(`SELECT payload, status FROM notification_outbox WHERE recipient = $1 AND template = 'generic_notice' ORDER BY created_at`, [to.toLowerCase()]);
  return r.rows as { payload: { subject: string; heading: string; paragraphs: string[]; url: string }; status: string }[];
}
