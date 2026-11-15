import { asWorker, schema, withTenant, withWorker, type Db } from "@jadwalin/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import { bookingCode } from "./booking-code";
import { AppError } from "./errors";
import { createPendingFile, finalizeFile, signDownload } from "./files";
import { notifyEmails, notifyStaff } from "./notify";
import { normalizePhone } from "./phone";
import { lockPayment, transition } from "./payments";
import {
  applyCancel,
  applyReschedule,
  assertWithinChangeWindow,
  clientContact,
  formatWhen,
  getBookingByToken,
  loadBookingById,
  loadChangeContext,
  manage,
  unionSlots,
  hostIdsOf,
  type BookingHooks,
  type ManagedBooking,
} from "./public-booking";
import { consumeRateLimit, rateKey } from "./rate-limit";
import type { StorageAdapter } from "./storage";
import { hashToken, newToken } from "./tokens";
import { audit, withWorkspace, type Actor } from "./workspace";

/**
 * Perubahan booking oleh pelanggan dengan persetujuan penyedia jasa (ADR 0004):
 * - Pembatalan booking yang DP-nya sudah dibayar: pelanggan mengajukan, penyedia menyetujui (dan menentukan nominal refund),
 *   mentransfer sendiri, lalu mengunggah bukti. Booking baru batal setelah bukti refund diunggah. Pelanggan melihat buktinya.
 * - Ubah jadwal pada usaha bermode persetujuan.
 * - Pemulihan tautan booking lewat kode booking + nomor HP (tanpa email).
 * jadwalin tidak memegang uang; refund dilakukan penyedia di luar sistem.
 */

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const REFUND_PROOF_MIMES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const REFUND_PROOF_MAX_BYTES = 5 * 1024 * 1024;

export type RequestKind = "cancel" | "reschedule";
export type RequestStatus = "requested" | "approved" | "rejected" | "completed" | "withdrawn";

/** Tautan WhatsApp biasa (wa.me): manusia yang menekan Kirim. Bukan API, tidak mengirim otomatis. */
export function waLink(phone: string | null | undefined, text: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

const base = (baseUrl: string) => baseUrl.replace(/\/$/, "");
/** Tautan non-rahasia ke halaman pemulihan booking (pelanggan tetap harus memasukkan nomor HP-nya). */
export const recoverUrl = (baseUrl: string, slug: string, bookingId: string) => `${base(baseUrl)}/booking/cari?u=${encodeURIComponent(slug)}&kode=${bookingCode(bookingId)}`;

const cleanText = (v: string | undefined | null, min: number, max: number, label: string): string => {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  if (t.length < min || t.length > max) throw new AppError("invalid_input", `${label} ${min}–${max} karakter.`);
  return t;
};

// --- Sisi pelanggan --------------------------------------------------------------------------------

export interface BookingRequestView {
  id: string;
  kind: RequestKind;
  status: RequestStatus;
  reason: string | null;
  newStartsAt: Date | null;
  refundAmountIdr: number | null;
  decisionNote: string | null;
  decidedAt: Date | null;
  refundedAt: Date | null;
  customerAck: "received" | "not_received" | null;
  /** URL unduh bukti refund (berumur pendek); hanya setelah penyedia mengunggahnya. */
  refundProofUrl: string | null;
  refundProofMime: string | null;
  createdAt: Date;
}

export interface BookingChangeView {
  policy: { rescheduleMode: "auto" | "approval"; changeMinHours: number; windowOpen: boolean };
  /** DP manual yang sudah dibayar (pembatalan harus lewat persetujuan bila ada). */
  paid: { amountIdr: number } | null;
  /** Permintaan terbaru (aktif bila ada, bila tidak yang terakhir diputuskan). */
  request: BookingRequestView | null;
}

export async function getBookingChangeView(pool: pg.Pool, storage: StorageAdapter | undefined, token: string, now = new Date()): Promise<BookingChangeView | null> {
  const b = await getBookingByToken(pool, token, now);
  if (!b) return null;
  return withTenant(pool, { userId: NIL_UUID, workspaceId: b.workspaceId, actor: "public", bookingTokenHash: hashToken(token) }, async (db) => {
    const ctx = await loadChangeContext(db, b);
    const rows = await asWorker(db, (w) =>
      w
        .select({ r: schema.bookingRequests, mime: schema.files.mime, storageKey: schema.files.storageKey, filename: schema.files.filename, fileStatus: schema.files.status })
        .from(schema.bookingRequests)
        .leftJoin(schema.files, eq(schema.files.id, schema.bookingRequests.refundFileId))
        .where(eq(schema.bookingRequests.bookingId, b.id))
        .orderBy(desc(schema.bookingRequests.createdAt))
        .limit(5),
    );
    const active = rows.find((x) => x.r.status === "requested" || x.r.status === "approved");
    const pick = active ?? rows.find((x) => x.r.status !== "withdrawn") ?? null;
    let request: BookingRequestView | null = null;
    if (pick) {
      const r = pick.r;
      const showProof = r.status === "completed" && pick.fileStatus === "ready" && pick.storageKey && storage;
      request = {
        id: r.id,
        kind: r.kind as RequestKind,
        status: r.status as RequestStatus,
        reason: r.reason,
        newStartsAt: r.newStartsAt,
        refundAmountIdr: r.refundAmountIdr,
        decisionNote: r.decisionNote,
        decidedAt: r.decidedAt,
        refundedAt: r.refundedAt,
        customerAck: (r.customerAck as "received" | "not_received" | null) ?? null,
        refundProofUrl: showProof ? await storage.presignDownload({ key: pick.storageKey!, filename: pick.filename ?? "bukti-refund" }) : null,
        refundProofMime: showProof ? pick.mime : null,
        createdAt: r.createdAt,
      };
    }
    return {
      policy: { rescheduleMode: ctx.rescheduleMode, changeMinHours: ctx.changeMinHours, windowOpen: ctx.changeMinHours === 0 || b.startsAt.getTime() - now.getTime() >= ctx.changeMinHours * 3_600_000 },
      paid: ctx.paid ? { amountIdr: ctx.paid.amountIdr } : null,
      request,
    };
  });
}

async function insertRequest(db: Db, b: ManagedBooking, v: { kind: RequestKind; reason: string | null; refundAccount?: string | null; newStartsAt?: Date | null }): Promise<string> {
  try {
    const [row] = await asWorker(db, (w) =>
      w.insert(schema.bookingRequests).values({ workspaceId: b.workspaceId, bookingId: b.id, kind: v.kind, reason: v.reason, refundAccount: v.refundAccount ?? null, newStartsAt: v.newStartsAt ?? null }).returning({ id: schema.bookingRequests.id }),
    );
    return row!.id;
  } catch (e) {
    const pg = e as { code?: string; cause?: { code?: string } };
    if (pg.code === "23505" || pg.cause?.code === "23505") throw new AppError("invalid_input", "Sudah ada permintaan yang menunggu untuk booking ini.");
    throw e;
  }
}

/** Pelanggan mengajukan pembatalan booking yang DP-nya sudah dibayar. */
export async function requestCancellation(pool: pg.Pool, token: string, input: { reason: string; refundAccount: string }, opts: { baseUrl: string; now?: Date }) {
  const now = opts.now ?? new Date();
  const reason = cleanText(input.reason, 3, 300, "Alasan");
  const refundAccount = cleanText(input.refundAccount, 5, 200, "Tujuan pengembalian dana (bank/e-wallet, nomor, atas nama)");
  return manage(pool, token, now, async (db, b) => {
    if (!b.canChange) throw new AppError("invalid_input", "Booking ini sudah tidak bisa diubah.");
    const ctx = await loadChangeContext(db, b);
    if (!ctx.paid) throw new AppError("invalid_input", "Booking ini belum ada DP yang dibayar; batalkan langsung.");
    assertWithinChangeWindow(b, ctx.changeMinHours, now);
    const id = await insertRequest(db, b, { kind: "cancel", reason, refundAccount });
    await audit(db, { workspaceId: b.workspaceId, actorUserId: null, action: "booking_request.cancel_requested", entityType: "booking_request", entityId: id });
    const who = await clientContact(db, b.clientId);
    await notifyStaff(db, b.workspaceId, { assigneeMemberId: b.memberId }, (to) => ({
      to,
      subject: `Pengajuan pembatalan: ${who.name}`,
      heading: `${who.name} mengajukan pembatalan booking`,
      paragraphs: [`${b.type.title} — ${formatWhen(b.startsAt, b.workspace.timezone)}`, `DP terbayar Rp${ctx.paid!.amountIdr.toLocaleString("id-ID")}. Setujui atau tolak, lalu kembalikan dana dan unggah buktinya.`],
      ctaLabel: "Buka permintaan",
      url: `${base(opts.baseUrl)}/w/${b.workspace.slug}/perubahan`,
      dedupeKey: `booking_request:${id}:created:${to}`,
    }));
    if (who.email) await notifyEmails(db, b.workspaceId, [{ to: who.email, subject: `Pengajuan pembatalan diterima: ${b.type.title}`, heading: "Pengajuan pembatalan Anda diterima", paragraphs: [`${b.type.title} — ${formatWhen(b.startsAt, b.workspace.timezone)}`, "Penyedia jasa akan memeriksanya. Booking tetap berlaku sampai disetujui."], ctaLabel: "Lihat status", url: recoverUrl(opts.baseUrl, b.workspace.slug, b.id), dedupeKey: `booking_request:${id}:created:guest` }]);
    return { requestId: id };
  });
}

/** Pelanggan mengajukan ubah jadwal (usaha bermode persetujuan). Slot lama tetap ditahan sampai diputuskan. */
export async function requestReschedule(pool: pg.Pool, token: string, newStartsAt: Date, input: { note?: string }, opts: { baseUrl: string; now?: Date }) {
  const now = opts.now ?? new Date();
  if (Number.isNaN(newStartsAt.getTime())) throw new AppError("invalid_input", "Pilih waktu terlebih dulu.");
  const note = input.note?.trim() ? cleanText(input.note, 1, 300, "Catatan") : null;
  return manage(pool, token, now, async (db, b) => {
    if (!b.canChange) throw new AppError("invalid_input", "Booking ini sudah tidak bisa diubah.");
    const ctx = await loadChangeContext(db, b);
    if (ctx.rescheduleMode !== "approval") throw new AppError("invalid_input", "Jadwal bisa diubah langsung, tanpa permintaan.");
    assertWithinChangeWindow(b, ctx.changeMinHours, now);
    const hosts = await hostIdsOf(db, b.meetingTypeId);
    const slots = await unionSlots(db, b.workspaceId, b.meetingTypeId, hosts, now, b.id);
    if (!slots.some((s) => s.start.getTime() === newStartsAt.getTime())) throw new AppError("slot_unavailable", "Jadwal itu sudah tidak tersedia. Pilih waktu lain.");
    const id = await insertRequest(db, b, { kind: "reschedule", reason: note, newStartsAt });
    await audit(db, { workspaceId: b.workspaceId, actorUserId: null, action: "booking_request.reschedule_requested", entityType: "booking_request", entityId: id, diff: { to: newStartsAt.toISOString() } });
    const who = await clientContact(db, b.clientId);
    await notifyStaff(db, b.workspaceId, { assigneeMemberId: b.memberId }, (to) => ({
      to,
      subject: `Permintaan ubah jadwal: ${who.name}`,
      heading: `${who.name} meminta mengubah jadwal`,
      paragraphs: [`${b.type.title}: ${formatWhen(b.startsAt, b.workspace.timezone)} → ${formatWhen(newStartsAt, b.workspace.timezone)}`],
      ctaLabel: "Buka permintaan",
      url: `${base(opts.baseUrl)}/w/${b.workspace.slug}/perubahan`,
      dedupeKey: `booking_request:${id}:created:${to}`,
    }));
    if (who.email) await notifyEmails(db, b.workspaceId, [{ to: who.email, subject: `Permintaan ubah jadwal diterima: ${b.type.title}`, heading: "Permintaan ubah jadwal Anda diterima", paragraphs: [`${b.type.title}: ${formatWhen(b.startsAt, b.workspace.timezone)} → ${formatWhen(newStartsAt, b.workspace.timezone)}`, "Jadwal lama tetap berlaku sampai penyedia jasa menyetujui."], ctaLabel: "Lihat status", url: recoverUrl(opts.baseUrl, b.workspace.slug, b.id), dedupeKey: `booking_request:${id}:created:guest` }]);
    return { requestId: id };
  });
}

/** Pelanggan menarik permintaan yang belum diputuskan. */
export async function withdrawRequest(pool: pg.Pool, token: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return manage(pool, token, now, async (db, b) => {
    const done = await asWorker(db, (w) =>
      w.update(schema.bookingRequests).set({ status: "withdrawn" }).where(and(eq(schema.bookingRequests.bookingId, b.id), eq(schema.bookingRequests.status, "requested"))).returning({ id: schema.bookingRequests.id }),
    );
    if (done.length === 0) throw new AppError("invalid_input", "Tidak ada permintaan yang bisa ditarik.");
    await audit(db, { workspaceId: b.workspaceId, actorUserId: null, action: "booking_request.withdrawn", entityType: "booking_request", entityId: done[0]!.id });
  });
}

/** Pelanggan mengonfirmasi dana sudah diterima (atau belum masuk) setelah penyedia mengunggah bukti refund. */
export async function acknowledgeRefund(pool: pg.Pool, token: string, ack: "received" | "not_received", opts: { baseUrl: string; now?: Date }) {
  const now = opts.now ?? new Date();
  if (ack !== "received" && ack !== "not_received") throw new AppError("invalid_input", "Pilihan tidak valid.");
  return manage(pool, token, now, async (db, b) => {
    const done = await asWorker(db, (w) =>
      w
        .update(schema.bookingRequests)
        .set({ customerAck: ack, customerAckAt: now })
        .where(and(eq(schema.bookingRequests.bookingId, b.id), eq(schema.bookingRequests.kind, "cancel"), eq(schema.bookingRequests.status, "completed")))
        .returning({ id: schema.bookingRequests.id }),
    );
    if (done.length === 0) throw new AppError("invalid_input", "Belum ada pengembalian dana untuk dikonfirmasi.");
    const id = done[0]!.id;
    await audit(db, { workspaceId: b.workspaceId, actorUserId: null, action: `booking_request.refund_${ack}`, entityType: "booking_request", entityId: id });
    if (ack === "not_received") {
      const who = await clientContact(db, b.clientId);
      await notifyStaff(db, b.workspaceId, { assigneeMemberId: b.memberId }, (to) => ({
        to,
        subject: `Pelanggan belum menerima refund: ${who.name}`,
        heading: `${who.name} melaporkan dana belum masuk`,
        paragraphs: [`${b.type.title} — ${formatWhen(b.startsAt, b.workspace.timezone)}`, "Periksa kembali tujuan transfer dan bukti refund, lalu hubungi pelanggan."],
        ctaLabel: "Buka permintaan",
        url: `${base(opts.baseUrl)}/w/${b.workspace.slug}/perubahan`,
        dedupeKey: `booking_request:${id}:not_received:${now.getTime()}:${to}`,
      }));
    }
  });
}

// --- Pemulihan tautan (tanpa email) ---------------------------------------------------------------

/**
 * Pelanggan yang kehilangan tautan memasukkan kode booking + nomor HP. Bila cocok, token kelola DIPUTAR (tautan lama berhenti
 * berlaku) dan token baru dikembalikan. Gagal selalu bernada sama agar kombinasi yang benar tidak bisa ditebak; dibatasi laju.
 */
export async function recoverBooking(pool: pg.Pool, slug: string, input: { code: string; phone: string }, opts: { clientIdentity?: string; now?: Date } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const fail = () => new AppError("invalid_input", "Kode booking atau nomor HP tidak cocok. Periksa kembali.");
  let phone: string;
  try {
    phone = normalizePhone(input.phone);
  } catch {
    throw fail();
  }
  const code = input.code.trim().toUpperCase();
  if (!/^JDW-[A-Z0-9]{6}$/.test(code)) throw fail();
  const key = slug.toLowerCase();
  if (opts.clientIdentity) await consumeRateLimit(pool, rateKey("recover-ip", opts.clientIdentity), { limit: 20, windowSec: 3600, now, message: "Terlalu banyak percobaan. Coba lagi nanti." });
  await consumeRateLimit(pool, rateKey("recover-phone", `${key}|${phone}`), { limit: 5, windowSec: 3600, now, message: "Terlalu banyak percobaan untuk nomor ini. Coba lagi nanti." });
  const token = newToken(24);
  const ok = await withWorker(pool, async (db) => {
    const [ws] = await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(and(eq(schema.workspaces.slug, key), sql`${schema.workspaces.deletedAt} IS NULL`, sql`${schema.workspaces.blockedAt} IS NULL`)).limit(1);
    if (!ws) return false;
    const clients = await db.select({ id: schema.workspaceClients.id }).from(schema.workspaceClients).where(and(eq(schema.workspaceClients.workspaceId, ws.id), eq(schema.workspaceClients.phone, phone)));
    if (clients.length === 0) return false;
    const rows = await db
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(and(eq(schema.bookings.workspaceId, ws.id), inArray(schema.bookings.clientId, clients.map((c) => c.id))))
      .orderBy(desc(schema.bookings.startsAt))
      .limit(50);
    const hit = rows.find((r) => bookingCode(r.id) === code);
    if (!hit) return false;
    const done = await db.update(schema.bookings).set({ cancelTokenHash: hashToken(token) }).where(eq(schema.bookings.id, hit.id)).returning({ id: schema.bookings.id });
    return done.length === 1;
  });
  if (!ok) throw fail();
  return token;
}

// --- Sisi penyedia jasa (staf) -----------------------------------------------------------------------

export interface BookingRequestRow {
  id: string;
  bookingId: string;
  bookingCode: string;
  kind: RequestKind;
  status: RequestStatus;
  reason: string | null;
  refundAccount: string | null;
  newStartsAt: Date | null;
  refundAmountIdr: number | null;
  decisionNote: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  refundedAt: Date | null;
  customerAck: string | null;
  startsAt: Date;
  typeTitle: string;
  clientName: string;
  clientPhone: string | null;
  clientEmail: string | null;
  /** DP manual yang dibayar untuk booking ini (nominal awal), bila ada. */
  paidIdr: number | null;
  hasRefundProof: boolean;
}

/** `open` = menunggu keputusan atau menunggu refund; `all` = 100 terbaru. */
export async function listBookingRequests(pool: pg.Pool, actor: Actor, filter: "open" | "all" = "open"): Promise<BookingRequestRow[]> {
  return withWorkspace(pool, actor, "staff", async (db) => {
    const rows = await db
      .select({
        r: schema.bookingRequests,
        startsAt: schema.bookings.startsAt,
        typeTitle: schema.meetingTypes.title,
        clientName: schema.workspaceClients.name,
        clientPhone: schema.workspaceClients.phone,
        clientEmail: schema.workspaceClients.email,
        paidIdr: sql<number | null>`(SELECT p.amount_idr FROM payments p WHERE p.subject_type = 'booking' AND p.subject_id = ${schema.bookingRequests.bookingId} AND p.provider = 'manual' AND p.status IN ('paid','refund_pending','partially_refunded','refunded') LIMIT 1)`,
        fileStatus: schema.files.status,
      })
      .from(schema.bookingRequests)
      .innerJoin(schema.bookings, eq(schema.bookings.id, schema.bookingRequests.bookingId))
      .innerJoin(schema.meetingTypes, eq(schema.meetingTypes.id, schema.bookings.meetingTypeId))
      .innerJoin(schema.workspaceClients, eq(schema.workspaceClients.id, schema.bookings.clientId))
      .leftJoin(schema.files, eq(schema.files.id, schema.bookingRequests.refundFileId))
      .where(filter === "open" ? inArray(schema.bookingRequests.status, ["requested", "approved"]) : sql`${schema.bookingRequests.status} <> 'withdrawn'`)
      .orderBy(sql`(${schema.bookingRequests.status} IN ('requested','approved')) DESC`, desc(schema.bookingRequests.createdAt))
      .limit(100);
    return rows.map((x) => ({
      id: x.r.id,
      bookingId: x.r.bookingId,
      bookingCode: bookingCode(x.r.bookingId),
      kind: x.r.kind as RequestKind,
      status: x.r.status as RequestStatus,
      reason: x.r.reason,
      refundAccount: x.r.refundAccount,
      newStartsAt: x.r.newStartsAt,
      refundAmountIdr: x.r.refundAmountIdr,
      decisionNote: x.r.decisionNote,
      createdAt: x.r.createdAt,
      decidedAt: x.r.decidedAt,
      refundedAt: x.r.refundedAt,
      customerAck: x.r.customerAck,
      startsAt: x.startsAt,
      typeTitle: x.typeTitle,
      clientName: x.clientName,
      clientPhone: x.clientPhone,
      clientEmail: x.clientEmail,
      paidIdr: x.paidIdr === null ? null : Number(x.paidIdr),
      hasRefundProof: x.fileStatus === "ready",
    }));
  });
}

/** Jumlah permintaan yang butuh tindakan penyedia (lencana menu). */
export async function countOpenBookingRequests(pool: pg.Pool, actor: Actor): Promise<number> {
  return withWorkspace(pool, actor, "staff", async (db) => {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.bookingRequests).where(inArray(schema.bookingRequests.status, ["requested", "approved"]));
    return r?.n ?? 0;
  });
}

export type RequestDecision = { approve: true; refundAmountIdr?: number; note?: string } | { approve: false; note: string };

/**
 * Penyedia memutuskan permintaan.
 * - Pembatalan disetujui: `approved` + nominal refund; bila nominal 0, booking langsung batal. Bila > 0, booking baru batal
 *   setelah bukti refund diunggah (`completeRefund`).
 * - Ubah jadwal disetujui: dipindahkan saat itu juga (slot dicek ulang; bila sudah diambil, gagal dan penyedia bisa menolak).
 */
export async function decideBookingRequest(pool: pg.Pool, actor: Actor, requestId: string, decision: RequestDecision, opts: { baseUrl: string; hooks?: BookingHooks; now?: Date }) {
  const now = opts.now ?? new Date();
  if (!decision.approve) decision = { approve: false, note: cleanText(decision.note, 3, 300, "Alasan penolakan") };
  else if (decision.note?.trim()) decision = { ...decision, note: cleanText(decision.note, 1, 300, "Catatan") };
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const [req] = await db.select().from(schema.bookingRequests).where(eq(schema.bookingRequests.id, requestId)).for("update").limit(1);
    if (!req) throw new AppError("not_found", "Permintaan tidak ditemukan.");
    if (req.status !== "requested") throw new AppError("invalid_input", "Permintaan ini sudah diputuskan.");
    const b = await loadBookingById(db, req.bookingId, now);
    if (!b) throw new AppError("not_found", "Booking tidak ditemukan.");
    const who = await clientContact(db, b.clientId);
    const link = recoverUrl(opts.baseUrl, b.workspace.slug, b.id);
    const when = formatWhen(b.startsAt, b.workspace.timezone);
    const mailGuest = async (subject: string, heading: string, paragraphs: string[], key: string) => {
      if (who.email) await notifyEmails(db, b.workspaceId, [{ to: who.email, subject, heading, paragraphs, ctaLabel: "Lihat status", url: link, dedupeKey: `booking_request:${req.id}:${key}` }]);
    };
    const stamp = { decidedBy: actor.userId, decidedAt: now };

    if (!decision.approve) {
      await db.update(schema.bookingRequests).set({ status: "rejected", decisionNote: decision.note, ...stamp }).where(eq(schema.bookingRequests.id, req.id));
      await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "booking_request.rejected", entityType: "booking_request", entityId: req.id });
      await mailGuest(req.kind === "cancel" ? `Pengajuan pembatalan ditolak: ${b.type.title}` : `Permintaan ubah jadwal ditolak: ${b.type.title}`, req.kind === "cancel" ? "Pengajuan pembatalan Anda belum dapat disetujui" : "Permintaan ubah jadwal Anda belum dapat disetujui", [`${b.type.title} — ${when}`, `Alasan: ${decision.note}`, "Booking Anda tetap berlaku."], "rejected");
      return { status: "rejected" as const };
    }

    if (req.kind === "reschedule") {
      if (!req.newStartsAt) throw new AppError("invalid_input", "Permintaan ini tidak memuat waktu baru.");
      await applyReschedule(db, b, req.newStartsAt, { baseUrl: opts.baseUrl, now, hooks: opts.hooks, by: "host" });
      await db.update(schema.bookingRequests).set({ status: "completed", decisionNote: decision.note ?? null, ...stamp }).where(eq(schema.bookingRequests.id, req.id));
      await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "booking_request.approved", entityType: "booking_request", entityId: req.id });
      return { status: "completed" as const };
    }

    // Pembatalan: nominal refund ≤ DP terbayar.
    const ctx = await loadChangeContext(db, b);
    if (!ctx.paid) throw new AppError("invalid_input", "DP booking ini tidak lagi berstatus terbayar.");
    const amount = decision.refundAmountIdr ?? ctx.paid.amountIdr;
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > ctx.paid.amountIdr) throw new AppError("invalid_input", `Nominal refund 0 – Rp${ctx.paid.amountIdr.toLocaleString("id-ID")}.`);
    if (amount === 0) {
      await applyCancel(db, b, { baseUrl: opts.baseUrl, now, hooks: opts.hooks, by: "host" });
      await db.update(schema.bookingRequests).set({ status: "completed", refundAmountIdr: 0, decisionNote: decision.note ?? null, refundedAt: now, ...stamp }).where(eq(schema.bookingRequests.id, req.id));
      await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "booking_request.approved_no_refund", entityType: "booking_request", entityId: req.id });
      return { status: "completed" as const };
    }
    await db.update(schema.bookingRequests).set({ status: "approved", refundAmountIdr: amount, decisionNote: decision.note ?? null, ...stamp }).where(eq(schema.bookingRequests.id, req.id));
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "booking_request.approved", entityType: "booking_request", entityId: req.id, diff: { refundAmountIdr: amount } });
    await mailGuest(`Pembatalan disetujui: ${b.type.title}`, "Pembatalan Anda disetujui", [`${b.type.title} — ${when}`, `Dana Rp${amount.toLocaleString("id-ID")} akan dikembalikan ke rekening yang Anda isi. Anda akan melihat bukti transfernya di halaman booking.`], "approved");
    return { status: "approved" as const };
  });
}

/** Minta URL unggah bukti refund (penyedia). Berkas diikat ke permintaan ini; mengunggah ulang menggantikan yang lama. */
export async function requestRefundProofUpload(pool: pg.Pool, actor: Actor, storage: StorageAdapter, requestId: string, req: { filename: string; mime: string; sizeBytes: number }) {
  if (!REFUND_PROOF_MIMES.includes(req.mime.trim().toLowerCase())) throw new AppError("invalid_input", "Bukti harus berupa gambar (PNG/JPG/WebP) atau PDF.");
  if (!Number.isInteger(req.sizeBytes) || req.sizeBytes <= 0 || req.sizeBytes > REFUND_PROOF_MAX_BYTES) throw new AppError("invalid_input", "Ukuran bukti maksimal 5 MB.");
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const [r] = await db.select().from(schema.bookingRequests).where(eq(schema.bookingRequests.id, requestId)).for("update").limit(1);
    if (!r || r.kind !== "cancel") throw new AppError("not_found", "Permintaan tidak ditemukan.");
    if (r.status !== "approved") throw new AppError("invalid_input", "Bukti refund hanya bisa diunggah setelah pembatalan disetujui.");
    const created = await createPendingFile(db, { workspaceId: access.workspaceId }, storage, actor.userId, req);
    await db.update(schema.bookingRequests).set({ refundFileId: created.fileId }).where(eq(schema.bookingRequests.id, r.id));
    return created;
  });
}

/**
 * Bukti refund sudah diunggah: berkas diverifikasi, pembayaran → refunded/partially_refunded lewat state machine, booking batal,
 * permintaan selesai, pelanggan diberi tahu. Hanya berkas yang diikat ke permintaan ini yang dipakai.
 */
export async function completeRefund(pool: pg.Pool, actor: Actor, storage: StorageAdapter, requestId: string, opts: { baseUrl: string; hooks?: BookingHooks; now?: Date }) {
  const now = opts.now ?? new Date();
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const [req] = await db.select().from(schema.bookingRequests).where(eq(schema.bookingRequests.id, requestId)).for("update").limit(1);
    if (!req || req.kind !== "cancel") throw new AppError("not_found", "Permintaan tidak ditemukan.");
    if (req.status !== "approved" || !req.refundFileId || !req.refundAmountIdr) throw new AppError("invalid_input", "Unggah bukti refund terlebih dulu.");
    const fin = await finalizeFile(db, storage, req.refundFileId);
    if (!fin.ok) throw new AppError("invalid_input", fin.reason);
    const b = await loadBookingById(db, req.bookingId, now);
    if (!b) throw new AppError("not_found", "Booking tidak ditemukan.");
    const refunded = req.refundAmountIdr;
    await asWorker(db, async (w) => {
      const p = await lockPayment(w, and(eq(schema.payments.subjectType, "booking"), eq(schema.payments.subjectId, b.id), eq(schema.payments.provider, "manual")));
      if (!p || p.status !== "paid") throw new AppError("invalid_input", "DP booking ini tidak berstatus terbayar.");
      await transition(w, p, refunded >= p.amountIdr ? "refunded" : "partially_refunded", "admin", { requestId: req.id, refundAmountIdr: refunded, reviewer: actor.userId }, {}, now);
    });
    try {
      await applyCancel(db, b, { baseUrl: opts.baseUrl, now, hooks: opts.hooks, by: "host" });
    } catch (e) {
      // Booking sudah tidak aktif (mis. sudah lewat): dana tetap tercatat dikembalikan.
      if (!(e instanceof AppError)) throw e;
    }
    await db.update(schema.bookingRequests).set({ status: "completed", refundedAt: now }).where(eq(schema.bookingRequests.id, req.id));
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "booking_request.refund_completed", entityType: "booking_request", entityId: req.id, diff: { refundAmountIdr: refunded } });
    const who = await clientContact(db, b.clientId);
    if (who.email) {
      await notifyEmails(db, b.workspaceId, [{ to: who.email, subject: `Dana dikembalikan: ${b.type.title}`, heading: "Dana Anda sudah dikembalikan", paragraphs: [`${b.type.title} — ${formatWhen(b.startsAt, b.workspace.timezone)}`, `Rp${refunded.toLocaleString("id-ID")} sudah ditransfer. Lihat bukti transfernya di halaman booking dan konfirmasi bila sudah diterima.`], ctaLabel: "Lihat bukti refund", url: recoverUrl(opts.baseUrl, b.workspace.slug, b.id), dedupeKey: `booking_request:${req.id}:refunded` }]);
    }
    return { status: "completed" as const };
  });
}

/** URL unduh bukti refund untuk penyedia (berumur pendek, tercatat di audit). */
export async function getRefundProofUrl(pool: pg.Pool, actor: Actor, storage: StorageAdapter, requestId: string) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const [r] = await db.select({ fileId: schema.bookingRequests.refundFileId }).from(schema.bookingRequests).where(eq(schema.bookingRequests.id, requestId)).limit(1);
    if (!r?.fileId) throw new AppError("not_found", "Bukti refund belum ada.");
    return signDownload(db, access, storage, actor.userId, r.fileId);
  });
}

// --- Pengaturan perubahan (pemilik/admin) ---------------------------------------------------------------

export async function getChangeSettings(pool: pg.Pool, actor: Actor): Promise<{ rescheduleMode: "auto" | "approval"; changeMinHours: number }> {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const [ws] = await db.select({ mode: schema.workspaces.rescheduleMode, minHours: schema.workspaces.changeMinHours }).from(schema.workspaces).where(eq(schema.workspaces.id, access.workspaceId)).limit(1);
    return { rescheduleMode: ws?.mode === "approval" ? "approval" : "auto", changeMinHours: ws?.minHours ?? 0 };
  });
}

export async function setChangeSettings(pool: pg.Pool, actor: Actor, input: { rescheduleMode: "auto" | "approval"; changeMinHours: number }) {
  if (input.rescheduleMode !== "auto" && input.rescheduleMode !== "approval") throw new AppError("invalid_input", "Mode ubah jadwal tidak valid.");
  if (!Number.isInteger(input.changeMinHours) || input.changeMinHours < 0 || input.changeMinHours > 720) throw new AppError("invalid_input", "Batas waktu 0–720 jam.");
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    await db.update(schema.workspaces).set({ rescheduleMode: input.rescheduleMode, changeMinHours: input.changeMinHours }).where(eq(schema.workspaces.id, access.workspaceId));
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "workspace.change_policy_updated", entityType: "workspace", entityId: access.workspaceId, diff: input });
  });
}

// --- Kontak WhatsApp usaha dan kirim-ulang tautan (tanpa API; manusia yang menekan Kirim) ----------------------------

export async function getContactPhone(pool: pg.Pool, actor: Actor): Promise<string | null> {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const [ws] = await db.select({ p: schema.workspaces.contactPhone }).from(schema.workspaces).where(eq(schema.workspaces.id, access.workspaceId)).limit(1);
    return ws?.p ?? null;
  });
}

/** Nomor HP anggota tim (dari profil akun mereka) yang bisa dipilih sebagai kontak publik usaha. */
export async function listContactCandidates(pool: pg.Pool, actor: Actor): Promise<{ name: string; role: string; phone: string }[]> {
  return withWorkspace(pool, actor, "admin", async (db) => {
    const rows = await db
      .select({ name: schema.users.name, phone: schema.users.phone, role: schema.workspaceMembers.role })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .orderBy(schema.workspaceMembers.createdAt);
    return rows.filter((r): r is { name: string; phone: string; role: "owner" | "admin" | "staff" } => !!r.phone);
  });
}

/** Nomor WhatsApp usaha (wajib). Dinormalisasi ke 62xxx lewat fungsi tunggal core. */
export async function setContactPhone(pool: pg.Pool, actor: Actor, phone: string) {
  // Wajib (ADR 0004): pelanggan harus punya jalan menghubungi penyedia jasa.
  if (!phone.trim()) throw new AppError("invalid_input", "Nomor WhatsApp usaha wajib diisi.");
  let value: string;
  try {
    value = normalizePhone(phone);
  } catch {
    throw new AppError("invalid_input", "Nomor WhatsApp tidak valid. Gunakan format 08xx atau +62xx.");
  }
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    await db.update(schema.workspaces).set({ contactPhone: value }).where(eq(schema.workspaces.id, access.workspaceId));
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "workspace.contact_phone_updated", entityType: "workspace", entityId: access.workspaceId });
  });
}

/**
 * Pintasan penyedia: tautan WhatsApp (wa.me) ke nomor pelanggan dengan pesan berisi ringkasan booking dan tautan pemulihan
 * (kode booking; pelanggan memasukkan nomor HP-nya). Murni penyusun alamat: tanpa panggilan server, tanpa memutar token,
 * tidak mengirim apa pun. Penyedia sendiri yang menekan Kirim di WhatsApp.
 */
export function bookingWhatsAppLink(p: { phone: string | null | undefined; clientName: string; wsName: string; wsSlug: string; typeTitle: string; startsAt: Date; timezone: string; bookingId: string; baseUrl: string }): string {
  const text = `Halo ${p.clientName}, terkait booking Anda di ${p.wsName}.\n${p.typeTitle} — ${formatWhen(p.startsAt, p.timezone)} (kode ${bookingCode(p.bookingId)})\nLihat status, bayar, ubah, atau batalkan di sini (masukkan nomor HP Anda): ${recoverUrl(p.baseUrl, p.wsSlug, p.bookingId)}`;
  return waLink(p.phone, text);
}
