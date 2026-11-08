import { schema, withTenant } from "@jadwalin/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { AppError, isUniqueViolation } from "./errors";
import { enqueueEmail } from "./notifications";
import { consumeRateLimit, normalizeRecipientKey, rateKey } from "./rate-limit";
import { hashToken, newToken } from "./tokens";
import { audit, withWorkspace, type Actor, type Role } from "./workspace";

const INVITE_TTL_MS = 7 * 24 * 3600_000;
const ROLE_LABEL: Record<Exclude<Role, "owner">, string> = { admin: "admin", staff: "staf" };
const INVALID = "Undangan tidak valid, sudah dipakai, atau sudah kedaluwarsa.";

/**
 * Mengundang lewat email. Token hanya ada di email (di DB hanya hash-nya), sekali pakai, berlaku 7 hari,
 * dan hanya bisa diterima oleh akun dengan email terverifikasi yang SAMA dengan alamat undangan.
 * Admin boleh mengundang staf; mengundang admin hanya oleh owner.
 */
export async function inviteMember(
  pool: pg.Pool,
  actor: Actor,
  input: { email: string; role: Exclude<Role, "owner"> },
  opts: { baseUrl: string; now?: Date },
) {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new AppError("invalid_input", "Alamat email tidak valid.");
  const now = opts.now ?? new Date();
  const minRole: Role = input.role === "admin" ? "owner" : "admin";
  // Undangan memicu email ke alamat sembarang: batasi per penerima (seluruh platform) dan per pengundang.
  await consumeRateLimit(pool, rateKey("invite-recipient", normalizeRecipientKey(email)), { limit: 3, windowSec: 86400, now, message: "Alamat ini sudah menerima beberapa undangan hari ini. Coba lagi besok." });
  await consumeRateLimit(pool, rateKey("invite-actor", actor.userId), { limit: 30, windowSec: 86400, now, message: "Terlalu banyak undangan hari ini. Coba lagi besok." });

  return withWorkspace(pool, actor, minRole, async (db, access) => {
    const existing = await db
      .select({ id: schema.workspaceMembers.id })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(sql`lower(${schema.users.email}) = ${email}`)
      .limit(1);
    if (existing.length > 0) throw new AppError("already_member", "Orang ini sudah menjadi anggota.");

    const token = newToken();
    let inviteId: string;
    try {
      const [row] = await db
        .insert(schema.workspaceInvitations)
        .values({ workspaceId: access.workspaceId, email, role: input.role, tokenHash: hashToken(token), invitedBy: actor.userId, expiresAt: new Date(now.getTime() + INVITE_TTL_MS) })
        .returning({ id: schema.workspaceInvitations.id });
      inviteId = row!.id;
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError("invitation_exists", "Sudah ada undangan aktif untuk email ini. Batalkan dulu jika ingin mengirim ulang.");
      throw error;
    }

    const [ws] = await db.select({ name: schema.workspaces.name }).from(schema.workspaces).where(eq(schema.workspaces.id, access.workspaceId)).limit(1);
    const [inviter] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, actor.userId)).limit(1);
    await enqueueEmail(db, {
      workspaceId: access.workspaceId,
      to: email,
      template: "workspace_invite",
      payload: { url: `${opts.baseUrl.replace(/\/$/, "")}/undangan/${token}`, workspaceName: ws?.name ?? "workspace", inviterName: inviter?.name ?? "Seseorang", roleLabel: ROLE_LABEL[input.role] },
      dedupeKey: `invite:${inviteId}`,
      now,
    });
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "invitation.created", entityType: "workspace_invitation", entityId: inviteId, diff: { email, role: input.role } });
    return { id: inviteId };
  });
}

export async function listInvitations(pool: pg.Pool, actor: Actor, now = new Date()) {
  return withWorkspace(pool, actor, "admin", (db) =>
    db
      .select({ id: schema.workspaceInvitations.id, email: schema.workspaceInvitations.email, role: schema.workspaceInvitations.role, expiresAt: schema.workspaceInvitations.expiresAt })
      .from(schema.workspaceInvitations)
      .where(and(isNull(schema.workspaceInvitations.acceptedAt), isNull(schema.workspaceInvitations.revokedAt), sql`${schema.workspaceInvitations.expiresAt} > ${now.toISOString()}::timestamptz`))
      .orderBy(desc(schema.workspaceInvitations.createdAt)),
  );
}

export async function revokeInvitation(pool: pg.Pool, actor: Actor, invitationId: string) {
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    const [inv] = await db.select().from(schema.workspaceInvitations).where(eq(schema.workspaceInvitations.id, invitationId)).limit(1);
    if (!inv) throw new AppError("not_found", "Undangan tidak ditemukan.");
    if (inv.role === "admin" && access.role !== "owner") throw new AppError("forbidden", "Hanya owner yang bisa membatalkan undangan admin.");
    await db.update(schema.workspaceInvitations).set({ revokedAt: new Date() }).where(and(eq(schema.workspaceInvitations.id, invitationId), isNull(schema.workspaceInvitations.acceptedAt)));
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "invitation.revoked", entityType: "workspace_invitation", entityId: invitationId });
  });
}

/** Pratinjau untuk halaman terima undangan. Tidak membocorkan apa pun bila token/akun tidak cocok. */
export async function previewInvitation(pool: pg.Pool, userId: string, token: string, now = new Date()) {
  const tokenHash = hashToken(token);
  return withTenant(pool, { userId, inviteTokenHash: tokenHash }, async (db) => {
    const [me] = await db.select({ email: schema.users.email, verified: schema.users.emailVerified }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const [inv] = await db.select().from(schema.workspaceInvitations).where(eq(schema.workspaceInvitations.tokenHash, tokenHash)).limit(1);
    if (!me || !inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt <= now) return null;
    const [ws] = await db.select({ name: schema.workspaces.name }).from(schema.workspaces).where(eq(schema.workspaces.id, inv.workspaceId)).limit(1);
    return {
      workspaceName: ws?.name ?? "workspace",
      role: inv.role,
      invitedEmail: inv.email,
      /** Akun login boleh menerima hanya bila email-nya sama dan sudah terverifikasi. */
      canAccept: me.email.toLowerCase() === inv.email.toLowerCase() && me.verified,
      emailMismatch: me.email.toLowerCase() !== inv.email.toLowerCase(),
      needsVerification: !me.verified,
    };
  });
}

export async function acceptInvitation(pool: pg.Pool, userId: string, token: string, now = new Date()): Promise<{ slug: string }> {
  const tokenHash = hashToken(token);
  const found = await withTenant(pool, { userId, inviteTokenHash: tokenHash }, async (db) => {
    const [me] = await db.select({ email: schema.users.email, verified: schema.users.emailVerified }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const [inv] = await db.select().from(schema.workspaceInvitations).where(eq(schema.workspaceInvitations.tokenHash, tokenHash)).limit(1);
    if (!me || !inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt <= now) throw new AppError("invitation_invalid", INVALID);
    if (me.email.toLowerCase() !== inv.email.toLowerCase()) throw new AppError("invitation_invalid", "Undangan ini ditujukan ke email lain. Masuk dengan email yang diundang.");
    if (!me.verified) throw new AppError("invitation_invalid", "Verifikasi email Anda dulu sebelum menerima undangan.");
    return inv;
  });

  return withTenant(pool, { userId, workspaceId: found.workspaceId }, async (db) => {
    // Pemakaian sekali: hanya satu penerimaan serentak yang lolos klaim ini.
    const claimed = await db
      .update(schema.workspaceInvitations)
      .set({ acceptedAt: now })
      .where(and(eq(schema.workspaceInvitations.id, found.id), isNull(schema.workspaceInvitations.acceptedAt), isNull(schema.workspaceInvitations.revokedAt), sql`${schema.workspaceInvitations.expiresAt} > ${now.toISOString()}::timestamptz`))
      .returning({ id: schema.workspaceInvitations.id });
    if (claimed.length === 0) throw new AppError("invitation_invalid", INVALID);
    try {
      await db.insert(schema.workspaceMembers).values({ workspaceId: found.workspaceId, userId, role: found.role });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError("already_member", "Anda sudah menjadi anggota workspace ini.");
      throw error;
    }
    await audit(db, { workspaceId: found.workspaceId, actorUserId: userId, action: "invitation.accepted", entityType: "workspace_invitation", entityId: found.id, diff: { role: found.role } });
    const [ws] = await db.select({ slug: schema.workspaces.slug }).from(schema.workspaces).where(eq(schema.workspaces.id, found.workspaceId)).limit(1);
    return { slug: ws!.slug };
  });
}
