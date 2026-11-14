import {
  AppError,
  audit,
  cancelBookingIn,
  createBookingIn,
  createPendingFile,
  finalizeFile,
  signDownload,
  withWorkspace,
  type Actor,
  type StorageAdapter,
  type UploadRequest,
  requireFeature,
} from "@jadwalin/core";
import { schema, type Db } from "@jadwalin/db";
import { and, asc, desc, eq, ilike, inArray, ne, sql } from "drizzle-orm";
import pg from "pg";
import { notifyEmails, notifyStaff, preview } from "./notify";
import { assertOpen, BODY_MAX, cleanBody, cleanTitle, findTicket, formatWhen, loadMeetings, nextTicketNumber, PRIORITIES, recordEvent, touchTicket, type Priority } from "./shared";
import { canTransition, type TicketStatus } from "./status";

export interface Opts {
  baseUrl: string;
}
const staffUrl = (o: Opts, slug: string, n: number) => `${o.baseUrl.replace(/\/$/, "")}/w/${slug}/tiket/${n}`;
const clientUrl = (o: Opts, slug: string, n: number) => `${o.baseUrl.replace(/\/$/, "")}/jadwal-saya/${slug}/tiket/${n}`;

async function loadClient(db: Db, clientId: string | null) {
  if (!clientId) return null;
  const [c] = await db.select().from(schema.workspaceClients).where(eq(schema.workspaceClients.id, clientId)).limit(1);
  return c ?? null;
}

async function workspaceName(db: Db, workspaceId: string): Promise<string> {
  const [w] = await db.select({ name: schema.workspaces.name, }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  return w?.name ?? "jadwalin";
}

async function assertMember(db: Db, memberId: string) {
  const [m] = await db.select({ id: schema.workspaceMembers.id, userId: schema.workspaceMembers.userId }).from(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, memberId)).limit(1);
  if (!m) throw new AppError("not_found", "Anggota tidak ditemukan.");
  return m;
}

// --- Buat & lihat ---------------------------------------------------------------------------

export interface CreateTicketInput {
  clientId: string;
  title: string;
  description?: string;
  priority?: Priority;
  assigneeMemberId?: string | null;
}

export async function createTicket(pool: pg.Pool, actor: Actor, input: CreateTicketInput, opts: Opts) {
  const title = cleanTitle(input.title);
  const description = cleanBody(input.description, "Deskripsi", false);
  const priority = input.priority ?? "normal";
  if (!PRIORITIES.includes(priority)) throw new AppError("invalid_input", "Prioritas tidak valid.");

  return withWorkspace(pool, actor, "staff", async (db, access) => {
    await requireFeature(db, access, "tiket");
    const client = await loadClient(db, input.clientId);
    if (!client) throw new AppError("not_found", "Klien tidak ditemukan.");
    const assignee = input.assigneeMemberId ? await assertMember(db, input.assigneeMemberId) : null;
    const number = await nextTicketNumber(db, access.workspaceId);
    const [t] = await db
      .insert(schema.tickets)
      .values({ workspaceId: access.workspaceId, number, title, description, priority, requesterUserId: client.userId, clientId: client.id, assigneeMemberId: assignee?.id ?? null })
      .returning({ id: schema.tickets.id });
    await recordEvent(db, { workspaceId: access.workspaceId, ticketId: t!.id, actorUserId: actor.userId, kind: "created", to: String(number) });
    if (assignee) {
      await recordEvent(db, { workspaceId: access.workspaceId, ticketId: t!.id, actorUserId: actor.userId, kind: "assign", to: assignee.id, clientVisible: false });
      if (assignee.userId !== actor.userId) {
        await notifyStaff(db, access.workspaceId, { assigneeMemberId: assignee.id }, (to) => ({ to, subject: `Tiket #${number} ditugaskan kepada Anda`, heading: `Tiket #${number} ditugaskan kepada Anda`, paragraphs: [title, `Klien: ${client.name}`], ctaLabel: "Buka tiket", url: staffUrl(opts, actor.slug, number), dedupeKey: `ticket:${t!.id}:assigned:${assignee.id}` }));
      }
    }
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "ticket.created", entityType: "ticket", entityId: t!.id, diff: { number, clientId: client.id } });
    return { id: t!.id, number };
  });
}

export interface ListFilters {
  status?: TicketStatus[] | "aktif";
  assignee?: "me" | "none" | string;
  q?: string;
  limit?: number;
  offset?: number;
}

export async function listTickets(pool: pg.Pool, actor: Actor, filters: ListFilters = {}) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const where = [];
    if (filters.status === "aktif") where.push(ne(schema.tickets.status, "closed"));
    else if (Array.isArray(filters.status) && filters.status.length > 0) where.push(inArray(schema.tickets.status, filters.status));
    if (filters.assignee === "me") where.push(eq(schema.tickets.assigneeMemberId, access.memberId));
    else if (filters.assignee === "none") where.push(sql`${schema.tickets.assigneeMemberId} IS NULL`);
    else if (filters.assignee) where.push(eq(schema.tickets.assigneeMemberId, filters.assignee));
    const q = filters.q?.trim();
    if (q) where.push(ilike(schema.tickets.title, `%${q.replace(/[%_\\]/g, "\\$&")}%`));

    return db
      .select({
        number: schema.tickets.number,
        title: schema.tickets.title,
        status: schema.tickets.status,
        priority: schema.tickets.priority,
        lastActivityAt: schema.tickets.lastActivityAt,
        createdAt: schema.tickets.createdAt,
        clientName: schema.workspaceClients.name,
        assigneeName: schema.users.name,
        assigneeMemberId: schema.tickets.assigneeMemberId,
      })
      .from(schema.tickets)
      .leftJoin(schema.workspaceClients, eq(schema.workspaceClients.id, schema.tickets.clientId))
      .leftJoin(schema.workspaceMembers, eq(schema.workspaceMembers.id, schema.tickets.assigneeMemberId))
      .leftJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(and(...where))
      .orderBy(desc(schema.tickets.lastActivityAt))
      .limit(Math.min(filters.limit ?? 100, 200))
      .offset(filters.offset ?? 0);
  });
}

export async function getTicket(pool: pg.Pool, actor: Actor, number: number) {
  return withWorkspace(pool, actor, "staff", async (db) => {
    const ticket = await findTicket(db, number);
    const client = await loadClient(db, ticket.clientId);
    const [assignee] = ticket.assigneeMemberId
      ? await db.select({ memberId: schema.workspaceMembers.id, name: schema.users.name }).from(schema.workspaceMembers).innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId)).where(eq(schema.workspaceMembers.id, ticket.assigneeMemberId)).limit(1)
      : [];
    const comments = await db
      .select({ id: schema.ticketComments.id, body: schema.ticketComments.body, internal: schema.ticketComments.internal, authorKind: schema.ticketComments.authorKind, authorUserId: schema.ticketComments.authorUserId, authorName: schema.users.name, createdAt: schema.ticketComments.createdAt })
      .from(schema.ticketComments)
      .leftJoin(schema.users, eq(schema.users.id, schema.ticketComments.authorUserId))
      .where(eq(schema.ticketComments.ticketId, ticket.id))
      .orderBy(asc(schema.ticketComments.createdAt));
    const attachments = await db
      .select({ id: schema.ticketAttachments.id, filename: schema.files.filename, mime: schema.files.mime, sizeBytes: schema.files.sizeBytes, contextNote: schema.ticketAttachments.contextNote, clientVisible: schema.ticketAttachments.clientVisible, commentId: schema.ticketAttachments.commentId, uploadedBy: schema.ticketAttachments.uploadedBy, uploadedByName: schema.users.name, createdAt: schema.ticketAttachments.createdAt })
      .from(schema.ticketAttachments)
      .innerJoin(schema.files, eq(schema.files.id, schema.ticketAttachments.fileId))
      .leftJoin(schema.users, eq(schema.users.id, schema.ticketAttachments.uploadedBy))
      .where(eq(schema.ticketAttachments.ticketId, ticket.id))
      .orderBy(asc(schema.ticketAttachments.createdAt));
    const events = await db
      .select({ id: schema.ticketEvents.id, kind: schema.ticketEvents.kind, from: schema.ticketEvents.fromValue, to: schema.ticketEvents.toValue, clientVisible: schema.ticketEvents.clientVisible, actorUserId: schema.ticketEvents.actorUserId, actorName: schema.users.name, createdAt: schema.ticketEvents.createdAt })
      .from(schema.ticketEvents)
      .leftJoin(schema.users, eq(schema.users.id, schema.ticketEvents.actorUserId))
      .where(eq(schema.ticketEvents.ticketId, ticket.id))
      .orderBy(asc(schema.ticketEvents.createdAt));
    const meetings = await loadMeetings(db, ticket.id);
    // Klien bukan anggota workspace sehingga `users` tidak terlihat oleh staf; namanya diambil dari catatan klien.
    const nameOf = (userId: string | null, joined: string | null) => joined ?? (userId && userId === ticket.requesterUserId ? (client?.name ?? null) : null);
    return {
      ticket,
      client,
      assignee: assignee ?? null,
      comments: comments.map((c) => ({ ...c, authorName: nameOf(c.authorUserId, c.authorName) })),
      attachments: attachments.map((a) => ({ ...a, uploadedByName: nameOf(a.uploadedBy, a.uploadedByName) })),
      events: events.map((e) => ({ ...e, actorName: nameOf(e.actorUserId, e.actorName) })),
      meetings,
    };
  });
}

// --- Mengubah ---------------------------------------------------------------------------------

export async function setTicketStatus(pool: pg.Pool, actor: Actor, number: number, to: TicketStatus, opts: Opts) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const t = await findTicket(db, number);
    if (!canTransition(t.status, to, "staff")) throw new AppError("invalid_input", "Perubahan status itu tidak diizinkan.");
    await touchTicket(db, t.id, { status: to, closedAt: to === "closed" ? new Date() : null });
    await recordEvent(db, { workspaceId: access.workspaceId, ticketId: t.id, actorUserId: actor.userId, kind: "status", from: t.status, to });
    if (to === "resolved" || to === "closed") {
      const client = await loadClient(db, t.clientId);
      if (client?.email) {
        const label = to === "resolved" ? "diselesaikan" : "ditutup";
        await notifyEmails(db, access.workspaceId, [{ to: client.email, subject: `Tiket #${number} ${label}`, heading: `Tiket #${number} ${label}`, paragraphs: [t.title, to === "resolved" ? "Jika masalah Anda belum beres, balas tiket ini untuk membukanya kembali." : "Terima kasih."], ctaLabel: "Lihat tiket", url: clientUrl(opts, actor.slug, number), dedupeKey: `ticket:${t.id}:status:${to}` }]);
      }
    }
  });
}

export async function setTicketPriority(pool: pg.Pool, actor: Actor, number: number, priority: Priority) {
  if (!PRIORITIES.includes(priority)) throw new AppError("invalid_input", "Prioritas tidak valid.");
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const t = await findTicket(db, number);
    assertOpen(t);
    if (t.priority === priority) return;
    await touchTicket(db, t.id, { priority });
    await recordEvent(db, { workspaceId: access.workspaceId, ticketId: t.id, actorUserId: actor.userId, kind: "priority", from: t.priority, to: priority });
  });
}

/** Tunjuk tiket ke anggota (atau null = tanpa penanggung jawab). */
export async function assignTicket(pool: pg.Pool, actor: Actor, number: number, memberId: string | null, opts: Opts) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const t = await findTicket(db, number);
    assertOpen(t);
    const member = memberId ? await assertMember(db, memberId) : null;
    if ((member?.id ?? null) === t.assigneeMemberId) return;
    await touchTicket(db, t.id, { assigneeMemberId: member?.id ?? null });
    await recordEvent(db, { workspaceId: access.workspaceId, ticketId: t.id, actorUserId: actor.userId, kind: "assign", from: t.assigneeMemberId, to: member?.id ?? null, clientVisible: false });
    if (member && member.userId !== actor.userId) {
      await notifyStaff(db, access.workspaceId, { assigneeMemberId: member.id }, (to) => ({ to, subject: `Tiket #${number} ditugaskan kepada Anda`, heading: `Tiket #${number} ditugaskan kepada Anda`, paragraphs: [t.title], ctaLabel: "Buka tiket", url: staffUrl(opts, actor.slug, number), dedupeKey: `ticket:${t.id}:assigned:${member.id}:${Date.now()}` }));
    }
  });
}

export async function addStaffComment(pool: pg.Pool, actor: Actor, number: number, input: { body: string; internal?: boolean }, opts: Opts) {
  const body = cleanBody(input.body, "Komentar", true);
  const internal = input.internal === true;
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const t = await findTicket(db, number);
    assertOpen(t);
    const [c] = await db
      .insert(schema.ticketComments)
      .values({ workspaceId: access.workspaceId, ticketId: t.id, authorUserId: actor.userId, authorKind: "staff", body, internal })
      .returning({ id: schema.ticketComments.id });
    await touchTicket(db, t.id);
    if (!internal) {
      const client = await loadClient(db, t.clientId);
      if (client?.email) {
        const ws = await workspaceName(db, access.workspaceId);
        await notifyEmails(db, access.workspaceId, [{ to: client.email, subject: `Balasan untuk tiket #${number}`, heading: `${ws} membalas tiket #${number}`, paragraphs: [t.title, preview(body)], ctaLabel: "Lihat & balas", url: clientUrl(opts, actor.slug, number), dedupeKey: `ticket:${t.id}:comment:${c!.id}` }]);
      }
    }
    return { id: c!.id };
  });
}

// --- Lampiran ---------------------------------------------------------------------------------

/** Langkah 1: minta URL unggah. Berkas belum terlampir sampai dikonfirmasi. */
export async function requestAttachmentUpload(pool: pg.Pool, actor: Actor, storage: StorageAdapter, number: number, req: UploadRequest) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    assertOpen(await findTicket(db, number));
    return createPendingFile(db, access, storage, actor.userId, req);
  });
}

/** Langkah 2: setelah unggah, verifikasi berkas dan lampirkan ke tiket dengan catatan konteks. */
export async function confirmAttachment(
  pool: pg.Pool,
  actor: Actor,
  storage: StorageAdapter,
  number: number,
  input: { fileId: string; contextNote?: string; clientVisible?: boolean },
) {
  const contextNote = cleanBody(input.contextNote, "Catatan konteks", false) || null;
  const outcome = await withWorkspace(pool, actor, "staff", async (db, access) => {
    const t = await findTicket(db, number);
    assertOpen(t);
    const [file] = await db.select({ uploadedBy: schema.files.uploadedBy }).from(schema.files).where(eq(schema.files.id, input.fileId)).limit(1);
    if (!file) throw new AppError("not_found", "Berkas tidak ditemukan.");
    if (file.uploadedBy !== actor.userId) throw new AppError("forbidden", "Hanya pengunggah yang bisa melampirkan berkas ini.");
    const [already] = await db.select({ id: schema.ticketAttachments.id }).from(schema.ticketAttachments).where(eq(schema.ticketAttachments.fileId, input.fileId)).limit(1);
    if (already) throw new AppError("invalid_input", "Berkas ini sudah terlampir.");
    const fin = await finalizeFile(db, storage, input.fileId);
    if (!fin.ok) return fin; // status 'deleted' ikut commit; galat dilempar setelah transaksi selesai
    const clientVisible = input.clientVisible !== false;
    const [a] = await db
      .insert(schema.ticketAttachments)
      .values({ workspaceId: access.workspaceId, ticketId: t.id, fileId: input.fileId, contextNote, clientVisible, uploadedBy: actor.userId })
      .returning({ id: schema.ticketAttachments.id });
    await touchTicket(db, t.id);
    await recordEvent(db, { workspaceId: access.workspaceId, ticketId: t.id, actorUserId: actor.userId, kind: "attachment", to: fin.file.filename, clientVisible });
    return { ok: true as const, id: a!.id };
  });
  if (!outcome.ok) throw new AppError("invalid_input", outcome.reason);
  return { id: outcome.id };
}

export async function downloadAttachment(pool: pg.Pool, actor: Actor, storage: StorageAdapter, number: number, attachmentId: string) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const t = await findTicket(db, number);
    const [a] = await db.select({ fileId: schema.ticketAttachments.fileId }).from(schema.ticketAttachments).where(and(eq(schema.ticketAttachments.id, attachmentId), eq(schema.ticketAttachments.ticketId, t.id))).limit(1);
    if (!a) throw new AppError("not_found", "Lampiran tidak ditemukan.");
    return signDownload(db, access, storage, actor.userId, a.fileId);
  });
}

// --- Meeting ----------------------------------------------------------------------------------

export interface ScheduleInput {
  meetingTypeId: string;
  memberId?: string;
  startsAt: Date;
  notes?: string;
  now?: Date;
}

/** Jadwalkan meeting dari tiket: booking, tautan tiket-meeting, riwayat, dan email ke klien dalam satu transaksi. */
export async function scheduleTicketMeeting(pool: pg.Pool, actor: Actor, number: number, input: ScheduleInput, opts: Opts) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const t = await findTicket(db, number);
    assertOpen(t);
    if (!t.clientId) throw new AppError("invalid_input", "Tiket ini belum punya klien.");
    const booking = await createBookingIn(db, access, actor.userId, { meetingTypeId: input.meetingTypeId, memberId: input.memberId, clientId: t.clientId, startsAt: input.startsAt, ticketId: t.id, notes: input.notes, now: input.now });
    await db.insert(schema.ticketMeetings).values({ workspaceId: access.workspaceId, ticketId: t.id, bookingId: booking.id });
    await touchTicket(db, t.id);
    await recordEvent(db, { workspaceId: access.workspaceId, ticketId: t.id, actorUserId: actor.userId, kind: "meeting", to: booking.startsAt.toISOString() });
    const [ws] = await db.select({ name: schema.workspaces.name, timezone: schema.workspaces.timezone }).from(schema.workspaces).where(eq(schema.workspaces.id, access.workspaceId)).limit(1);
    const client = await loadClient(db, t.clientId);
    if (client?.email) {
      const where = booking.meetingType.locationValue ? `${booking.meetingType.locationKind === "link" ? "Link" : booking.meetingType.locationKind === "phone" ? "Telepon" : "Lokasi"}: ${booking.meetingType.locationValue}` : "";
      await notifyEmails(db, access.workspaceId, [{ to: client.email, subject: `Meeting dijadwalkan: ${booking.meetingType.title}`, heading: `Meeting dijadwalkan dengan ${ws?.name ?? "kami"}`, paragraphs: [`${booking.meetingType.title} — ${formatWhen(booking.startsAt, ws?.timezone ?? "Asia/Jakarta")}`, ...(where ? [where] : []), `Terkait tiket #${number}: ${t.title}`], ctaLabel: "Lihat tiket", url: clientUrl(opts, actor.slug, number), dedupeKey: `booking:${booking.id}:scheduled` }]);
    }
    return { bookingId: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt };
  });
}

export async function cancelTicketMeeting(pool: pg.Pool, actor: Actor, number: number, bookingId: string, opts: Opts) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const t = await findTicket(db, number);
    const [link] = await db.select({ id: schema.ticketMeetings.id }).from(schema.ticketMeetings).where(and(eq(schema.ticketMeetings.ticketId, t.id), eq(schema.ticketMeetings.bookingId, bookingId))).limit(1);
    if (!link) throw new AppError("not_found", "Meeting tidak ditemukan pada tiket ini.");
    await cancelBookingIn(db, access, actor.userId, bookingId);
    await touchTicket(db, t.id);
    await recordEvent(db, { workspaceId: access.workspaceId, ticketId: t.id, actorUserId: actor.userId, kind: "meeting", to: "dibatalkan" });
    const client = await loadClient(db, t.clientId);
    if (client?.email) {
      await notifyEmails(db, access.workspaceId, [{ to: client.email, subject: `Meeting dibatalkan (tiket #${number})`, heading: "Meeting dibatalkan", paragraphs: [`Meeting yang terkait tiket #${number} (${t.title}) dibatalkan. Kami akan menghubungi Anda untuk menjadwalkan ulang.`], ctaLabel: "Lihat tiket", url: clientUrl(opts, actor.slug, number), dedupeKey: `booking:${bookingId}:cancelled` }]);
    }
  });
}

export { BODY_MAX };
