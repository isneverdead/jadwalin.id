import {
  AppError,
  audit,
  consumeRateLimit,
  hashToken,
  hostsOfType,
  requireFeature,
  insertBooking,
  newToken,
  pickAvailableHost,
  rateKey,
  sendBookingCreatedNotices,
  withClientAccess,
  type BookingHooks,
} from "@jadwalin/core";
import { schema } from "@jadwalin/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { assertOpen, findTicket, nextTicketNumber, recordEvent, touchTicket } from "./shared";
import type { ClientOpts } from "./client";

const MAX_BOOKINGS_PER_USER_PER_DAY = 10;

function ticketTitle(typeTitle: string, topic: string): string {
  return `Booking: ${typeTitle} — ${topic}`.replace(/\s+/g, " ").slice(0, 200);
}

/**
 * Hook booking → tiket (dipasang oleh lapisan aplikasi; core tidak mengenal tiket). Setiap booking dari halaman publik
 * otomatis menjadi tiket baru yang ditugaskan ke host, dengan meeting-nya tertaut. Dijalankan di transaksi booking yang sama.
 * Tamu belum punya akun: penulisan memakai id yang dibuat di muka (tanpa membaca balik), sesuai batasan RLS aktor 'public'.
 */
export function ticketBookingHooks(): BookingHooks {
  return {
    onBooked: async (db, ctx) => {
      if (!ctx.features.tiket) return; // usaha tidak memakai tiket: booking berdiri sendiri
      const ticketId = randomUUID();
      const number = await nextTicketNumber(db, ctx.workspaceId);
      const description = [`Topik: ${ctx.topic}`, ...(ctx.notes ? [ctx.notes] : []), "Dijadwalkan lewat halaman booking publik."].join("\n\n");
      await db.insert(schema.tickets).values({
        id: ticketId,
        workspaceId: ctx.workspaceId,
        number,
        title: ticketTitle(ctx.meetingType.title, ctx.topic),
        description,
        priority: "normal",
        requesterUserId: ctx.userId,
        clientId: ctx.client.id,
        assigneeMemberId: ctx.hostMemberId,
      });
      await db.insert(schema.ticketMeetings).values({ workspaceId: ctx.workspaceId, ticketId, bookingId: ctx.bookingId });
      await recordEvent(db, { workspaceId: ctx.workspaceId, ticketId, actorUserId: ctx.userId, kind: "created", to: String(number) });
      await recordEvent(db, { workspaceId: ctx.workspaceId, ticketId, actorUserId: ctx.userId, kind: "assign", to: ctx.hostMemberId, clientVisible: false });
      await recordEvent(db, { workspaceId: ctx.workspaceId, ticketId, actorUserId: ctx.userId, kind: "meeting", to: ctx.startsAt.toISOString() });
      return { ticketId };
    },
    onCancelled: async (db, ctx) => {
      if (!ctx.ticketId) return;
      await recordEvent(db, { workspaceId: ctx.workspaceId, ticketId: ctx.ticketId, actorUserId: null, kind: "meeting", to: "dibatalkan" });
    },
    onRescheduled: async (db, ctx) => {
      if (!ctx.ticketId) return;
      await recordEvent(db, { workspaceId: ctx.workspaceId, ticketId: ctx.ticketId, actorUserId: null, kind: "meeting", to: ctx.startsAt.toISOString() });
    },
  };
}

export interface ClientBookingInput {
  startsAt: Date;
  topic?: string;
  notes?: string;
  /** Tempelkan meeting ke tiket yang sudah ada (milik klien itu); kosong = buat tiket baru. */
  ticketNumber?: number;
}

/**
 * Pengguna terdaftar memesan lewat portal. Berbeda dari tamu: bisa menempelkan meeting ke tiketnya yang sudah ada.
 * Seluruhnya lewat konteks klien (RLS): tiket orang lain tak terjangkau, dan kegagalan slot membatalkan semuanya
 * (tidak ada tiket yatim).
 */
export async function bookAsClient(pool: pg.Pool, userId: string, slug: string, typeSlug: string, input: ClientBookingInput, opts: ClientOpts) {
  const now = opts.now ?? new Date();
  const topic = (input.topic ?? "").replace(/\s+/g, " ").trim();
  const notes = (input.notes ?? "").trim();
  if (Number.isNaN(input.startsAt.getTime())) throw new AppError("invalid_input", "Pilih waktu terlebih dulu.");
  if (!input.ticketNumber && topic.length < 3) throw new AppError("invalid_input", "Topik minimal 3 karakter.");
  if (topic.length > 200 || notes.length > 2000) throw new AppError("invalid_input", "Topik atau catatan terlalu panjang.");
  await consumeRateLimit(pool, rateKey("book-user", userId), { limit: MAX_BOOKINGS_PER_USER_PER_DAY, windowSec: 86400, now, message: "Terlalu banyak pemesanan hari ini. Coba lagi besok." });

  const token = newToken(24);
  return withClientAccess(pool, userId, slug, { createIfMissing: true, forWrite: true }, async (db, c) => {
    await requireFeature(db, c, "tiket"); // portal klien memesan lewat tiket
    const [type] = await db.select().from(schema.meetingTypes).where(and(eq(schema.meetingTypes.slug, typeSlug.toLowerCase()), eq(schema.meetingTypes.active, true))).limit(1);
    if (!type) throw new AppError("not_found", "Jenis pertemuan tidak ditemukan.");
    // DP lewat portal klien belum didukung: gagal tertutup agar booking berbayar tak pernah terkonfirmasi tanpa pembayaran.
    if (type.depositIdr > 0) throw new AppError("payment_unavailable", "Pertemuan berbayar saat ini hanya dapat dipesan lewat tautan publik halaman jadwal.");
    const hosts = await hostsOfType(db, type.id);
    if (hosts.length === 0) throw new AppError("not_found", "Jenis pertemuan ini belum tersedia.");
    const host = await pickAvailableHost(db, c.workspaceId, type.id, hosts, input.startsAt, now);

    const [me] = await db.select({ name: schema.workspaceClients.name, email: schema.workspaceClients.email, phone: schema.workspaceClients.phone }).from(schema.workspaceClients).where(eq(schema.workspaceClients.id, c.clientId)).limit(1);

    let ticketId: string;
    let ticketNumber: number;
    if (input.ticketNumber) {
      const t = await findTicket(db, input.ticketNumber);
      assertOpen(t);
      ticketId = t.id;
      ticketNumber = t.number;
    } else {
      ticketId = randomUUID();
      ticketNumber = await nextTicketNumber(db, c.workspaceId);
      await db.insert(schema.tickets).values({
        id: ticketId,
        workspaceId: c.workspaceId,
        number: ticketNumber,
        title: ticketTitle(type.title, topic),
        description: [`Topik: ${topic}`, ...(notes ? [notes] : [])].join("\n\n"),
        priority: "normal",
        requesterUserId: userId,
        clientId: c.clientId,
        assigneeMemberId: host,
      });
      await recordEvent(db, { workspaceId: c.workspaceId, ticketId, actorUserId: userId, kind: "created", to: String(ticketNumber) });
    }

    const booking = await insertBooking(db, { workspaceId: c.workspaceId, meetingTypeId: type.id, memberId: host, clientId: c.clientId, startsAt: input.startsAt, ticketId, notes: notes || topic || null, source: "client_portal", tokenHash: hashToken(token), now });
    await db.insert(schema.ticketMeetings).values({ workspaceId: c.workspaceId, ticketId, bookingId: booking.id });
    await recordEvent(db, { workspaceId: c.workspaceId, ticketId, actorUserId: userId, kind: "meeting", to: booking.startsAt.toISOString() });
    await touchTicket(db, ticketId);
    await audit(db, { workspaceId: c.workspaceId, actorUserId: userId, action: "booking.created_client", entityType: "booking", entityId: booking.id, diff: { hostMemberId: host, ticketNumber } });

    await sendBookingCreatedNotices(db, {
      workspace: { workspaceId: c.workspaceId, name: c.workspaceName, slug, timezone: c.timezone },
      bookingId: booking.id,
      startsAt: booking.startsAt,
      meta: { workspaceName: c.workspaceName, timezone: c.timezone, typeTitle: type.title, locationKind: type.locationKind, locationValue: type.locationValue },
      hostMemberId: host,
      token,
      guest: { name: me?.name ?? "Klien", email: me?.email ?? null, phone: me?.phone ?? null, topic: topic || `Tiket #${ticketNumber}`, notes },
      baseUrl: opts.baseUrl,
      now,
    });
    return { bookingId: booking.id, manageToken: token, startsAt: booking.startsAt, endsAt: booking.endsAt, ticketNumber, hostMemberId: host };
  });
}
