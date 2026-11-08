import { schema, withTenant } from "@jadwalin/db";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type pg from "pg";
import { AppError } from "./errors";
import { withWorkspace, type Actor } from "./workspace";

/**
 * Versi dokumen legal yang sedang berlaku. Naikkan setiap kali isi Syarat/Privasi berubah material; persetujuan lama
 * tetap tercatat dengan versinya sendiri sebagai bukti.
 */
export const LEGAL_VERSION = "2026-11-draft-1";

// --- Hak subjek data (UU PDP): ekspor + permintaan penghapusan ------------------------------------

/** Ekspor semua data milik pengguna yang dapat dibaca lewat konteks pengguna (RLS tetap berlaku). */
export async function exportMyData(pool: pg.Pool, userId: string) {
  return withTenant(pool, { userId }, async (db) => {
    const [user] = await db
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, phone: schema.users.phone, emailVerified: schema.users.emailVerified, termsVersion: schema.users.termsVersion, termsAcceptedAt: schema.users.termsAcceptedAt, createdAt: schema.users.createdAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    const memberships = await db
      .select({ workspace: schema.workspaces.name, slug: schema.workspaces.slug, role: schema.workspaceMembers.role, since: schema.workspaceMembers.createdAt })
      .from(schema.workspaceMembers)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
      .where(eq(schema.workspaceMembers.userId, userId));
    const clientRecords = await db
      .select({ workspace: schema.workspaces.name, slug: schema.workspaces.slug, name: schema.workspaceClients.name, email: schema.workspaceClients.email, phone: schema.workspaceClients.phone, consentVersion: schema.workspaceClients.consentVersion, consentAt: schema.workspaceClients.consentAt })
      .from(schema.workspaceClients)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceClients.workspaceId))
      .where(eq(schema.workspaceClients.userId, userId));
    const requests = await db.select({ kind: schema.dataRequests.kind, status: schema.dataRequests.status, createdAt: schema.dataRequests.createdAt }).from(schema.dataRequests).where(eq(schema.dataRequests.userId, userId));
    return { generatedAt: new Date().toISOString(), note: "Ekspor mandiri. Data tiket/booking di workspace milik penyedia jasa dikelola penyedia tersebut; hubungi mereka atau kami untuk salinan lengkap.", user: user ?? null, memberships, clientRecords, requests };
  });
}

/** Catat permintaan penghapusan akun. Diproses manual oleh operator (lihat docs/runbook.md); satu permintaan tertunda per pengguna. */
export async function requestAccountDeletion(pool: pg.Pool, userId: string): Promise<void> {
  try {
    await withTenant(pool, { userId }, (db) => db.insert(schema.dataRequests).values({ userId, kind: "delete" }));
  } catch (e) {
    if ((e as { code?: string; cause?: { code?: string } }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505") return; // sudah ada yang tertunda
    throw e;
  }
}

export async function listMyDataRequests(pool: pg.Pool, userId: string) {
  return withTenant(pool, { userId }, (db) => db.select().from(schema.dataRequests).where(eq(schema.dataRequests.userId, userId)).orderBy(desc(schema.dataRequests.createdAt)));
}

// --- Tampilan log audit (admin ke atas) -----------------------------------------------------------

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorName: string | null;
  createdAt: Date;
}

/** Log audit workspace, terbaru dulu, paginasi kursor waktu. Hanya admin/owner. `diff` sengaja tidak ditampilkan. */
export async function listAuditLog(pool: pg.Pool, actor: Actor, opts: { before?: Date; limit?: number } = {}): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return withWorkspace(pool, actor, "admin", (db, access) =>
    db
      .select({ id: schema.auditLog.id, action: schema.auditLog.action, entityType: schema.auditLog.entityType, entityId: schema.auditLog.entityId, actorName: schema.users.name, createdAt: schema.auditLog.createdAt })
      .from(schema.auditLog)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorUserId))
      .where(and(eq(schema.auditLog.workspaceId, access.workspaceId), opts.before ? lt(schema.auditLog.createdAt, opts.before) : sql`true`))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(limit),
  );
}

export function assertConsent(accepted: unknown): void {
  if (accepted !== true && accepted !== "on" && accepted !== "true") throw new AppError("invalid_input", "Anda perlu menyetujui Syarat Layanan dan Kebijakan Privasi.");
}
