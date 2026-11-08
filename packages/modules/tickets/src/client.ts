import {
  AppError,
  audit,
  consumeRateLimit,
  rateKey,
  createPendingFile,
  finalizeFile,
  signDownload,
  withClientAccess,
  type StorageAdapter,
  type UploadRequest,
} from "@jadwalin/core";
import { schema } from "@jadwalin/db";
import { and, asc, count, desc, eq, gte, ne, sql } from "drizzle-orm";
import pg from "pg";
import { notifyStaff, preview } from "./notify";
import { assertOpen, cleanBody, cleanTitle, DAILY_TICKET_LIMIT, findTicket, loadMeetings, nextTicketNumber, OPEN_TICKET_LIMIT, recordEvent, touchTicket } from "./shared";
import { canTransition } from "./status";

/**
 * Sisi klien. SEMUA fungsi lewat `withClientAccess`: konteks tenant 'client' + RLS membatasi baris pada
 * tiket milik pengguna itu. Tidak ada jalur di sini yang menerima id pengguna atau workspace dari input.
 */
export interface ClientOpts {
  baseUrl: string;
  now?: Date;
}
export const MAX_CLIENT_COMMENTS_PER_HOUR = 30;
export const MAX_COMMENTS_PER_TICKET = 300;
export const MAX_CLIENT_UPLOADS_PER_HOUR = 20;
export const MAX_ATTACHMENTS_PER_TICKET = 30;
const staffUrl = (o: ClientOpts, slug: string, n: number) => `${o.baseUrl.replace(/\/$/, "")}/w/${slug}/tiket/${n}`;

export async function createClientTicket(pool: pg.Pool, userId: string, slug: string, input: { title: string; description?: string }, opts: ClientOpts) {
  const title = cleanTitle(input.title);
  const description = cleanBody(input.description, "Deskripsi", false);
  return withClientAccess(pool, userId, slug, { createIfMissing: true, forWrite: true }, async (db, c) => {
    const since = new Date((opts.now ?? new Date()).getTime() - 24 * 3600_000);
    const [{ today }] = await db.select({ today: sql<number>`count(*)::int` }).from(schema.tickets).where(gte(schema.tickets.createdAt, since)) as [{ today: number }];
    if (today >= DAILY_TICKET_LIMIT) throw new AppError("invalid_input", `Batas ${DAILY_TICKET_LIMIT} tiket per hari tercapai. Coba lagi besok atau balas tiket yang sudah ada.`);
    const [{ open }] = await db.select({ open: sql<number>`count(*)::int` }).from(schema.tickets).where(ne(schema.tickets.status, "closed")) as [{ open: number }];
    if (open >= OPEN_TICKET_LIMIT) throw new AppError("invalid_input", "Anda punya terlalu banyak tiket terbuka. Tutup yang sudah selesai dulu.");

    const number = await nextTicketNumber(db, c.workspaceId);
    const [t] = await db
      .insert(schema.tickets)
      .values({ workspaceId: c.workspaceId, number, title, description, priority: "normal", requesterUserId: userId, clientId: c.clientId })
      .returning({ id: schema.tickets.id });
    await recordEvent(db, { workspaceId: c.workspaceId, ticketId: t!.id, actorUserId: userId, kind: "created", to: String(number) });
    await audit(db, { workspaceId: c.workspaceId, actorUserId: userId, action: "ticket.created", entityType: "ticket", entityId: t!.id, diff: { number, by: "client" } });
    await notifyStaff(db, c.workspaceId, { assigneeMemberId: null }, (to) => ({
      to,
      subject: `Tiket baru #${number}: ${title}`,
      heading: `Tiket baru #${number} dari klien`,
      paragraphs: [title, ...(description ? [preview(description)] : [])],
      ctaLabel: "Buka tiket",
      url: staffUrl(opts, slug, number),
      dedupeKey: `ticket:${t!.id}:created:${to}`,
    }));
    return { id: t!.id, number };
  });
}

export async function listMyTickets(pool: pg.Pool, userId: string, slug: string) {
  return withClientAccess(pool, userId, slug, {}, async (db, c) => {
    const tickets = await db
      .select({ number: schema.tickets.number, title: schema.tickets.title, status: schema.tickets.status, lastActivityAt: schema.tickets.lastActivityAt, createdAt: schema.tickets.createdAt })
      .from(schema.tickets)
      .orderBy(desc(schema.tickets.lastActivityAt))
      .limit(100);
    return { workspaceName: c.workspaceName, timezone: c.timezone, blocked: c.blocked, tickets };
  });
}

export async function getMyTicket(pool: pg.Pool, userId: string, slug: string, number: number) {
  return withClientAccess(pool, userId, slug, {}, async (db, c) => {
    const ticket = await findTicket(db, number);
    const comments = await db
      .select({ id: schema.ticketComments.id, body: schema.ticketComments.body, authorKind: schema.ticketComments.authorKind, createdAt: schema.ticketComments.createdAt })
      .from(schema.ticketComments)
      .where(eq(schema.ticketComments.ticketId, ticket.id))
      .orderBy(asc(schema.ticketComments.createdAt));
    const attachments = await db
      .select({ id: schema.ticketAttachments.id, filename: schema.files.filename, mime: schema.files.mime, sizeBytes: schema.files.sizeBytes, contextNote: schema.ticketAttachments.contextNote, createdAt: schema.ticketAttachments.createdAt })
      .from(schema.ticketAttachments)
      .innerJoin(schema.files, eq(schema.files.id, schema.ticketAttachments.fileId))
      .where(eq(schema.ticketAttachments.ticketId, ticket.id))
      .orderBy(asc(schema.ticketAttachments.createdAt));
    const events = await db
      .select({ id: schema.ticketEvents.id, kind: schema.ticketEvents.kind, from: schema.ticketEvents.fromValue, to: schema.ticketEvents.toValue, byMe: sql<boolean>`${schema.ticketEvents.actorUserId} = ${userId}`, createdAt: schema.ticketEvents.createdAt })
      .from(schema.ticketEvents)
      .where(eq(schema.ticketEvents.ticketId, ticket.id))
      .orderBy(asc(schema.ticketEvents.createdAt));
    const meetings = await loadMeetings(db, ticket.id);
    return {
      workspaceName: c.workspaceName,
      timezone: c.timezone,
      blocked: c.blocked,
      ticket: { number: ticket.number, title: ticket.title, description: ticket.description, status: ticket.status, createdAt: ticket.createdAt, lastActivityAt: ticket.lastActivityAt },
      comments,
      attachments,
      events,
      meetings,
    };
  });
}

export async function addClientComment(pool: pg.Pool, userId: string, slug: string, number: number, bodyText: string, opts: ClientOpts) {
  const body = cleanBody(bodyText, "Pesan", true);
  // Tiap balasan klien mengantre email ke staf: batasi per pengguna agar kuota email workspace tak bisa dikuras.
  await consumeRateLimit(pool, rateKey("client-comment", userId), { limit: MAX_CLIENT_COMMENTS_PER_HOUR, windowSec: 3600, now: opts.now, message: "Terlalu banyak pesan dalam satu jam. Coba lagi nanti." });
  return withClientAccess(pool, userId, slug, { forWrite: true }, async (db, c) => {
    const t = await findTicket(db, number);
    assertOpen(t);
    const [{ n }] = (await db.select({ n: count() }).from(schema.ticketComments).where(eq(schema.ticketComments.ticketId, t.id))) as [{ n: number }];
    if (n >= MAX_COMMENTS_PER_TICKET) throw new AppError("invalid_input", "Percakapan pada tiket ini sudah terlalu panjang. Buka tiket baru untuk topik lain.");
    const [row] = await db
      .insert(schema.ticketComments)
      .values({ workspaceId: c.workspaceId, ticketId: t.id, authorUserId: userId, authorKind: "client", body, internal: false })
      .returning({ id: schema.ticketComments.id });
    // Balasan klien mengembalikan tiket ke antrean staf bila sedang menunggu klien atau sudah diselesaikan.
    if ((t.status === "waiting_client" || t.status === "resolved") && canTransition(t.status, "open", "client")) {
      await touchTicket(db, t.id, { status: "open" });
      await recordEvent(db, { workspaceId: c.workspaceId, ticketId: t.id, actorUserId: userId, kind: "status", from: t.status, to: "open" });
    } else {
      await touchTicket(db, t.id);
    }
    await notifyStaff(db, c.workspaceId, { assigneeMemberId: t.assigneeMemberId }, (to) => ({
      to,
      subject: `Balasan klien pada tiket #${number}`,
      heading: `Klien membalas tiket #${number}`,
      paragraphs: [t.title, preview(body)],
      ctaLabel: "Buka tiket",
      url: staffUrl(opts, slug, number),
      dedupeKey: `ticket:${t.id}:comment:${row!.id}:${to}`,
    }));
    return { id: row!.id };
  });
}

/** Klien hanya boleh menutup tiketnya atau membukanya kembali bila sudah diselesaikan. */
export async function setMyTicketStatus(pool: pg.Pool, userId: string, slug: string, number: number, to: "closed" | "open") {
  return withClientAccess(pool, userId, slug, { forWrite: true }, async (db, c) => {
    const t = await findTicket(db, number);
    if (!canTransition(t.status, to, "client")) throw new AppError("invalid_input", "Perubahan status itu tidak diizinkan.");
    await touchTicket(db, t.id, { status: to, closedAt: to === "closed" ? new Date() : null });
    await recordEvent(db, { workspaceId: c.workspaceId, ticketId: t.id, actorUserId: userId, kind: "status", from: t.status, to });
  });
}

export async function requestClientAttachmentUpload(pool: pg.Pool, userId: string, slug: string, storage: StorageAdapter, number: number, req: UploadRequest) {
  await consumeRateLimit(pool, rateKey("client-upload", userId), { limit: MAX_CLIENT_UPLOADS_PER_HOUR, windowSec: 3600, message: "Terlalu banyak unggahan dalam satu jam. Coba lagi nanti." });
  return withClientAccess(pool, userId, slug, { forWrite: true }, async (db, c) => {
    const t = await findTicket(db, number);
    assertOpen(t);
    const [{ n }] = (await db.select({ n: count() }).from(schema.ticketAttachments).where(eq(schema.ticketAttachments.ticketId, t.id))) as [{ n: number }];
    if (n >= MAX_ATTACHMENTS_PER_TICKET) throw new AppError("invalid_input", "Jumlah lampiran pada tiket ini sudah mencapai batas.");
    return createPendingFile(db, c, storage, userId, req);
  });
}

export async function confirmClientAttachment(pool: pg.Pool, userId: string, slug: string, storage: StorageAdapter, number: number, input: { fileId: string; contextNote?: string }) {
  const contextNote = cleanBody(input.contextNote, "Catatan konteks", false) || null;
  const outcome = await withClientAccess(pool, userId, slug, { forWrite: true }, async (db, c) => {
    const t = await findTicket(db, number);
    assertOpen(t);
    const [file] = await db.select({ uploadedBy: schema.files.uploadedBy }).from(schema.files).where(eq(schema.files.id, input.fileId)).limit(1);
    if (!file || file.uploadedBy !== userId) throw new AppError("not_found", "Berkas tidak ditemukan.");
    const [already] = await db.select({ id: schema.ticketAttachments.id }).from(schema.ticketAttachments).where(eq(schema.ticketAttachments.fileId, input.fileId)).limit(1);
    if (already) throw new AppError("invalid_input", "Berkas ini sudah terlampir.");
    const fin = await finalizeFile(db, storage, input.fileId);
    if (!fin.ok) return fin;
    const [a] = await db
      .insert(schema.ticketAttachments)
      .values({ workspaceId: c.workspaceId, ticketId: t.id, fileId: input.fileId, contextNote, clientVisible: true, uploadedBy: userId })
      .returning({ id: schema.ticketAttachments.id });
    await touchTicket(db, t.id);
    await recordEvent(db, { workspaceId: c.workspaceId, ticketId: t.id, actorUserId: userId, kind: "attachment", to: fin.file.filename });
    return { ok: true as const, id: a!.id };
  });
  if (!outcome.ok) throw new AppError("invalid_input", outcome.reason);
  return { id: outcome.id };
}

export async function downloadClientAttachment(pool: pg.Pool, userId: string, slug: string, storage: StorageAdapter, number: number, attachmentId: string) {
  return withClientAccess(pool, userId, slug, {}, async (db, c) => {
    const t = await findTicket(db, number);
    const [a] = await db.select({ fileId: schema.ticketAttachments.fileId }).from(schema.ticketAttachments).where(and(eq(schema.ticketAttachments.id, attachmentId), eq(schema.ticketAttachments.ticketId, t.id))).limit(1);
    if (!a) throw new AppError("not_found", "Lampiran tidak ditemukan.");
    return signDownload(db, c, storage, userId, a.fileId);
  });
}
