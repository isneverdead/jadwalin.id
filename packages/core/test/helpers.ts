import { withWorker } from "@jadwalin/db";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { acceptInvitation, inviteMember, type Actor, type Role } from "../src";

/** Token undangan hanya ada di payload email; tes membacanya dari outbox seperti yang akan dilakukan penerima. */
export async function tokenFromOutbox(pool: pg.Pool, email: string): Promise<string> {
  const rows = await withWorker(pool, (db) =>
    db.execute<{ payload: { url: string } }>(sql`SELECT payload FROM notification_outbox WHERE recipient = ${email.toLowerCase()} AND template = 'workspace_invite' ORDER BY created_at DESC LIMIT 1`),
  );
  const url = rows.rows[0]?.payload?.url;
  if (!url) throw new Error(`Tidak ada email undangan untuk ${email}`);
  return url.split("/undangan/")[1]!;
}

/** Mengundang lalu menerima, untuk menyiapkan anggota di tes. Pengguna harus sudah ada dan terverifikasi. */
export async function inviteAndAccept(pool: pg.Pool, actor: Actor, who: { userId: string; email: string; role: Exclude<Role, "owner"> }) {
  await inviteMember(pool, actor, { email: who.email, role: who.role }, { baseUrl: "http://test.local" });
  const token = await tokenFromOutbox(pool, who.email);
  return acceptInvitation(pool, who.userId, token);
}
