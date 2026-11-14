import { asWorker, schema, withTenant, type Db } from "@jadwalin/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { AppError, isExclusionViolation } from "./errors";
import { parseFeatures, type Features } from "./features";
import { notifyEmails, notifyStaff, preview, type Notice } from "./notify";
import { LEGAL_VERSION } from "./legal";
import { normalizePhone } from "./phone";
import { consumeRateLimit, normalizeRecipientKey, rateKey } from "./rate-limit";
import { cancelOpenManualPayment, createManualPaymentInTx, hasActivePaymentMethod } from "./manual-payments";
import { createPayment, type PaymentDeps, type PaymentHooks } from "./payments";
import { bookingCode } from "./booking-code";
import { cancelBookingReminders, findMemberSlots, insertBooking } from "./scheduling";
import { hashToken, newToken } from "./tokens";
import { audit } from "./workspace";
import type { Slot } from "./slots";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MS_MIN = 60_000;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const ACTIVE = ["pending", "confirmed"] as const;

// Batas penyalahgunaan halaman publik (per jendela).
export const PUBLIC_LIMITS = {
  perIpPerHour: 10,
  perEmailPerDay: 3,
  /** Per penerima di SELURUH platform (bukan per workspace): mencegah platform dipakai membanjiri satu alamat. */
  perRecipientPerDayGlobal: 6,
  perWorkspacePerDay: 300,
  manageActionsPerTokenPerDay: 10,
} as const;

const REMINDERS = [
  { key: "24h", beforeMs: 24 * 60 * MS_MIN, label: "besok" },
  { key: "1h", beforeMs: 60 * MS_MIN, label: "1 jam lagi" },
] as const;

export function formatWhen(date: Date, timezone: string): string {
  const label = timezone === "Asia/Makassar" ? "WITA" : timezone === "Asia/Jayapura" ? "WIT" : "WIB";
  return `${new Intl.DateTimeFormat("id-ID", { timeZone: timezone, dateStyle: "full", timeStyle: "short", hour12: false }).format(date)} ${label}`;
}

// --- Konteks tamu --------------------------------------------------------------------------------

export interface PublicWorkspace {
  /** Fitur yang aktif untuk usaha ini (mis. tiket mati → halaman publik tidak menawarkan "Kirim pesan"). */
  features: Features;
  workspaceId: string;
  name: string;
  slug: string;
  timezone: string;
}

/**
 * Jalankan operasi sebagai TAMU (tanpa akun) di workspace `slug`. Slug adalah pengenal publik; RLS (migrasi 0011)
 * membatasi aktor 'public' pada: membaca jenis aktif/ketersediaan/rentang booking, menulis booking dan catatan klien tamu,
 * dan menulis (tanpa membaca) tiket baru. Token booking membuka satu booking tertentu.
 */
export async function withPublicWorkspace<T>(
  pool: pg.Pool,
  slug: string,
  fn: (db: Db, ws: PublicWorkspace) => Promise<T>,
  extra: { bookingTokenHash?: string } = {},
): Promise<T> {
  const key = slug.toLowerCase();
  const [ws] = await withTenant(pool, { userId: NIL_UUID, publicSlug: key, actor: "public" }, (db) =>
    db.select({ id: schema.workspaces.id, name: schema.workspaces.name, slug: schema.workspaces.slug, timezone: schema.workspaces.timezone, features: schema.workspaces.features }).from(schema.workspaces).where(and(eq(schema.workspaces.slug, key), isNull(schema.workspaces.deletedAt))).limit(1),
  );
  if (!ws) throw new AppError("not_found", "Halaman tidak ditemukan.");
  const info: PublicWorkspace = { workspaceId: ws.id, name: ws.name, slug: ws.slug, timezone: ws.timezone, features: parseFeatures(ws.features) };
  return withTenant(pool, { userId: NIL_UUID, workspaceId: ws.id, actor: "public", bookingTokenHash: extra.bookingTokenHash }, (db) => fn(db, info));
}

export interface PublicMeetingType {
  id: string;
  slug: string;
  title: string;
  durationMin: number;
  locationKind: "link" | "phone" | "in_person";
  maxDaysAhead: number;
  /** DP (Rupiah) yang akan ditagih; 0 = gratis. */
  depositIdr: number;
}

export async function hostIdsOf(db: Db, meetingTypeId: string): Promise<string[]> {
  const rows = await db.select({ memberId: schema.meetingTypeHosts.memberId }).from(schema.meetingTypeHosts).where(eq(schema.meetingTypeHosts.meetingTypeId, meetingTypeId));
  return rows.map((r) => r.memberId);
}

/** Halaman depan workspace: jenis pertemuan aktif yang punya host. Null bila workspace tidak ada. */
export async function getPublicOverview(pool: pg.Pool, slug: string): Promise<{ workspace: PublicWorkspace; types: PublicMeetingType[] } | null> {
  try {
    return await withPublicWorkspace(pool, slug, async (db, workspace) => {
      if (!workspace.features.jadwal) return { workspace, types: [] as PublicMeetingType[] };
      const types = await db
        .select({ id: schema.meetingTypes.id, slug: schema.meetingTypes.slug, title: schema.meetingTypes.title, durationMin: schema.meetingTypes.durationMin, locationKind: schema.meetingTypes.locationKind, maxDaysAhead: schema.meetingTypes.maxDaysAhead, depositIdr: schema.meetingTypes.depositIdr })
        .from(schema.meetingTypes)
        .where(eq(schema.meetingTypes.active, true))
        .orderBy(asc(schema.meetingTypes.title));
      const hosts = await db.select({ meetingTypeId: schema.meetingTypeHosts.meetingTypeId }).from(schema.meetingTypeHosts);
      const withHost = new Set(hosts.map((h) => h.meetingTypeId));
      return { workspace, types: types.filter((t) => withHost.has(t.id)) };
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") return null;
    throw error;
  }
}

async function findTypeBySlug(db: Db, typeSlug: string) {
  const [t] = await db.select().from(schema.meetingTypes).where(and(eq(schema.meetingTypes.slug, typeSlug.toLowerCase()), eq(schema.meetingTypes.active, true))).limit(1);
  return t ?? null;
}

/** Gabungan slot semua host (satu entri per waktu mulai). */
export async function unionSlots(db: Db, workspaceId: string, meetingTypeId: string, hostIds: string[], now: Date, ignoreBookingId?: string): Promise<Slot[]> {
  const byStart = new Map<number, Slot>();
  for (const memberId of hostIds) {
    for (const s of await findMemberSlots(db, workspaceId, { meetingTypeId, memberId, now, ignoreBookingId })) byStart.set(s.start.getTime(), s);
  }
  return [...byStart.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

export async function listPublicSlots(pool: pg.Pool, slug: string, typeSlug: string, opts: { now?: Date } = {}) {
  return withPublicWorkspace(pool, slug, async (db, workspace) => {
    if (!workspace.features.jadwal) return null;
    const type = await findTypeBySlug(db, typeSlug);
    if (!type) return null;
    const hosts = await hostIdsOf(db, type.id);
    const slots = hosts.length === 0 ? [] : await unionSlots(db, workspace.workspaceId, type.id, hosts, opts.now ?? new Date());
    const info: PublicMeetingType = { id: type.id, slug: type.slug, title: type.title, durationMin: type.durationMin, locationKind: type.locationKind, maxDaysAhead: type.maxDaysAhead, depositIdr: type.depositIdr };
    // DP tanpa metode bayar aktif tidak bisa dipesan: beri tahu pelanggan SEBELUM mengisi formulir, bukan setelahnya.
    const paymentReady = type.depositIdr === 0 || (await hasActivePaymentMethod(db, workspace.workspaceId));
    return { workspace, type: info, slots, paymentReady };
  });
}

// --- Email ---------------------------------------------------------------------------------------

export interface BookingMeta {
  workspaceName: string;
  timezone: string;
  typeTitle: string;
  locationKind: "link" | "phone" | "in_person";
  locationValue: string | null;
}

export const manageUrl = (baseUrl: string, token: string) => `${baseUrl.replace(/\/$/, "")}/booking/${token}`;

function whereLine(m: BookingMeta): string | null {
  if (!m.locationValue) return null;
  // Teks lokasi bebas ("tatap muka") tidak ikut ke email: bisa dimanfaatkan membawa pesan sembarang ke penerima.
  if (m.locationKind === "in_person") return "Lokasi: lihat di halaman kelola booking.";
  return `${m.locationKind === "link" ? "Link" : m.locationKind === "phone" ? "Telepon" : "Lokasi"}: ${m.locationValue}`;
}

export function guestNotices(bookingId: string, token: string, to: string, startsAt: Date, m: BookingMeta, baseUrl: string, kind: "confirmed" | "rescheduled" | "awaiting_payment", now: Date, holdLabel = "30 menit"): Notice[] {
  const url = manageUrl(baseUrl, token);
  const when = formatWhen(startsAt, m.timezone);
  const lines = [`${m.typeTitle} — ${when}`, `Kode booking: ${bookingCode(bookingId)}`, ...(whereLine(m) ? [whereLine(m)!] : []), "Perlu mengubah jadwal atau membatalkan? Gunakan tombol di bawah."];
  const notices: Notice[] = [
    {
      to,
      subject: kind === "confirmed" ? `Booking terkonfirmasi: ${m.typeTitle}` : kind === "awaiting_payment" ? `Menunggu pembayaran: ${m.typeTitle}` : `Jadwal diubah: ${m.typeTitle}`,
      heading: kind === "confirmed" ? `Booking Anda dengan ${m.workspaceName} terkonfirmasi` : kind === "awaiting_payment" ? `Selesaikan pembayaran untuk mengonfirmasi booking Anda` : `Jadwal baru Anda dengan ${m.workspaceName}`,
      paragraphs: kind === "awaiting_payment" ? [...lines.slice(0, -1), `Slot ditahan ${holdLabel}. Bayar lewat halaman kelola booking; bila tidak dibayar, slot dilepas otomatis.`] : lines,
      ctaLabel: "Kelola booking",
      url,
      dedupeKey: kind === "confirmed" ? `booking:${bookingId}:confirmed` : kind === "awaiting_payment" ? `booking:${bookingId}:awaiting-payment` : `booking:${bookingId}:rescheduled:${startsAt.getTime()}`,
      sensitive: true,
    },
  ];
  for (const r of REMINDERS) {
    const sendAt = new Date(startsAt.getTime() - r.beforeMs);
    if (sendAt.getTime() <= now.getTime() + 2 * MS_MIN) continue;
    notices.push({
      to,
      subject: `Pengingat: ${m.typeTitle} ${r.label}`,
      heading: `Pengingat: meeting dengan ${m.workspaceName} ${r.label}`,
      paragraphs: lines,
      ctaLabel: "Kelola booking",
      url,
      dedupeKey: `booking:${bookingId}:reminder:${r.key}:${startsAt.getTime()}`,
      sensitive: true,
      sendAt,
    });
  }
  return notices;
}


/**
 * Pilih host yang punya slot pada `startsAt`: yang booking mendatangnya paling sedikit (adil dan deterministik).
 * Melempar slot_unavailable bila tak ada.
 */
export async function pickAvailableHost(db: Db, workspaceId: string, meetingTypeId: string, hosts: string[], startsAt: Date, now: Date): Promise<string> {
  const load = await db.execute<{ member_id: string; n: number }>(sql`
    SELECT member_id, count(*)::int AS n FROM bookings
    WHERE member_id IN (${sql.join(hosts.map((h) => sql`${h}::uuid`), sql`, `)}) AND status IN ('pending', 'confirmed') AND starts_at > ${now.toISOString()}::timestamptz
    GROUP BY member_id`);
  const loadOf = new Map(load.rows.map((r) => [r.member_id, r.n]));
  const ordered = [...hosts].sort((a, b) => (loadOf.get(a) ?? 0) - (loadOf.get(b) ?? 0));
  for (const memberId of ordered) {
    const slots = await findMemberSlots(db, workspaceId, { meetingTypeId, memberId, now });
    if (slots.some((s) => s.start.getTime() === startsAt.getTime())) return memberId;
  }
  throw new AppError("slot_unavailable", "Jadwal itu sudah tidak tersedia. Pilih waktu lain.");
}

export async function hostsOfType(db: Db, meetingTypeId: string): Promise<string[]> {
  return hostIdsOf(db, meetingTypeId);
}

export interface BookingCreatedNotices {
  workspace: Omit<PublicWorkspace, "features">;
  bookingId: string;
  startsAt: Date;
  meta: BookingMeta;
  hostMemberId: string;
  token: string;
  guest: { name: string; email: string | null; phone: string | null; topic: string; notes: string };
  baseUrl: string;
  now: Date;
  /** Booking menunggu pembayaran DP: kirim tautan bayar, tunda pemberitahuan host. */
  awaitingPayment?: boolean;
  holdLabel?: string;
}

/** Email booking baru: konfirmasi + pengingat untuk tamu/klien, dan pemberitahuan untuk host. */
export async function sendBookingCreatedNotices(db: Db, p: BookingCreatedNotices): Promise<void> {
  if (p.awaitingPayment) {
    // Booking berDP: tamu dapat tautan kelola (untuk membayar); pemberitahuan host menunggu sampai lunas.
    if (p.guest.email) await notifyEmails(db, p.workspace.workspaceId, guestNotices(p.bookingId, p.token, p.guest.email, p.startsAt, p.meta, p.baseUrl, "awaiting_payment", p.now, p.holdLabel));
    return;
  }
  if (p.guest.email) await notifyEmails(db, p.workspace.workspaceId, guestNotices(p.bookingId, p.token, p.guest.email, p.startsAt, p.meta, p.baseUrl, "confirmed", p.now));
  await notifyStaff(db, p.workspace.workspaceId, { assigneeMemberId: p.hostMemberId }, (to) => ({
    to,
    subject: `Booking baru: ${p.guest.name} — ${p.meta.typeTitle}`,
    heading: `Booking baru dari ${p.guest.name}`,
    paragraphs: [`${p.meta.typeTitle} — ${formatWhen(p.startsAt, p.workspace.timezone)}`, `Topik: ${p.guest.topic}`, ...(p.guest.notes ? [preview(p.guest.notes)] : []), `Kontak: ${p.guest.email ?? "—"}${p.guest.phone ? `, ${p.guest.phone}` : ""}`],
    ctaLabel: "Buka dashboard",
    url: `${p.baseUrl.replace(/\/$/, "")}/w/${p.workspace.slug}/tiket`,
    dedupeKey: `booking:${p.bookingId}:host-created:${to}`,
  }));
}

// --- Hook modul (mis. tiket) ---------------------------------------------------------------------

export interface BookingHookContext {
  workspaceId: string;
  bookingId: string;
  startsAt: Date;
  endsAt: Date;
  meetingType: { id: string; title: string; locationKind: "link" | "phone" | "in_person"; locationValue: string | null };
  hostMemberId: string;
  client: { id: string; name: string; email: string | null; phone: string | null };
  topic: string;
  notes: string;
  /** Null untuk tamu tanpa akun. */
  userId: string | null;
  /** Fitur usaha: hook tiket tidak membuat tiket bila "tiket" dimatikan. */
  features: Features;
}

export interface BookingHooks {
  /** Dipanggil di transaksi yang sama setelah booking dibuat (mis. membuat tiket). Kembalikan id tiket untuk ditautkan. */
  onBooked?: (db: Db, ctx: BookingHookContext) => Promise<{ ticketId?: string | null } | void>;
  onCancelled?: (db: Db, ctx: { workspaceId: string; bookingId: string; ticketId: string | null }) => Promise<void>;
  onRescheduled?: (db: Db, ctx: { workspaceId: string; bookingId: string; ticketId: string | null; startsAt: Date }) => Promise<void>;
}

// --- Memesan -------------------------------------------------------------------------------------

export interface PublicBookingInput {
  name: string;
  /** Opsional (ADR 0004): tamu boleh hanya memberi nomor HP; tanpa email, kabar disampaikan lewat halaman booking dan penyedia jasa. */
  email?: string;
  phone?: string;
  topic: string;
  notes?: string;
  startsAt: Date;
  /** Tamu menyatakan telah membaca pemberitahuan privasi. Wajib untuk tamu tanpa akun. */
  privacyAck?: boolean;
}

export interface PublicBookingOptions {
  baseUrl: string;
  /** Wajib untuk jenis pertemuan berDP; tanpa ini pemesanan jenis berbayar ditolak (gagal tertutup). */
  payments?: PaymentDeps;
  now?: Date;
  /** Identitas pemanggil (mis. IP) untuk pembatas laju; di-hash sebelum disimpan. */
  clientIdentity?: string;
  hooks?: BookingHooks;
}

function validateGuest(input: PublicBookingInput) {
  const name = input.name.replace(/\s+/g, " ").trim();
  const email = (input.email ?? "").trim().toLowerCase() || null;
  const topic = input.topic.replace(/\s+/g, " ").trim();
  const notes = (input.notes ?? "").trim();
  if (name.length < 2 || name.length > 100) throw new AppError("invalid_input", "Nama harus 2–100 karakter.");
  if (email && (!EMAIL_RE.test(email) || email.length > 200)) throw new AppError("invalid_input", "Alamat email tidak valid.");
  if (topic.length < 3 || topic.length > 200) throw new AppError("invalid_input", "Topik harus 3–200 karakter.");
  if (notes.length > 2000) throw new AppError("invalid_input", "Catatan maksimal 2000 karakter.");
  if (Number.isNaN(input.startsAt.getTime())) throw new AppError("invalid_input", "Pilih waktu terlebih dulu.");
  if (input.privacyAck !== true) throw new AppError("invalid_input", "Centang persetujuan pemberitahuan privasi untuk melanjutkan.");
  let phone: string | null = null;
  if (input.phone?.trim()) {
    try {
      phone = normalizePhone(input.phone);
    } catch {
      throw new AppError("invalid_input", "Nomor HP tidak valid. Gunakan format 08xx atau +62xx.");
    }
  }
  if (!phone) throw new AppError("invalid_input", "Nomor HP (WhatsApp) wajib diisi.");
  return { name, email, topic, notes, phone };
}

export async function bookPublic(pool: pg.Pool, slug: string, typeSlug: string, input: PublicBookingInput, opts: PublicBookingOptions) {
  const guest = validateGuest(input);
  const now = opts.now ?? new Date();
  const key = slug.toLowerCase();
  // Pembatas dicatat di transaksi sendiri (percobaan yang gagal pun terhitung), sebelum pekerjaan berat.
  if (opts.clientIdentity) await consumeRateLimit(pool, rateKey("book-ip", opts.clientIdentity), { limit: PUBLIC_LIMITS.perIpPerHour, windowSec: 3600, now, message: "Terlalu banyak percobaan dari jaringan Anda. Coba lagi nanti." });
  await consumeRateLimit(pool, rateKey("book-recipient", guest.email ? normalizeRecipientKey(guest.email) : `tel:${guest.phone}`), { limit: PUBLIC_LIMITS.perRecipientPerDayGlobal, windowSec: 86400, now, message: "Alamat email ini sudah menerima terlalu banyak pesan hari ini. Coba lagi besok." });
  await consumeRateLimit(pool, rateKey("book-email", `${key}|${guest.email ? normalizeRecipientKey(guest.email) : `tel:${guest.phone}`}`), { limit: PUBLIC_LIMITS.perEmailPerDay, windowSec: 86400, now, message: "Email ini sudah dipakai memesan beberapa kali hari ini. Coba lagi besok atau hubungi kami langsung." });

  const token = newToken(24);
  const tokenHash = hashToken(token);

  const booked = await withPublicWorkspace(
    pool,
    slug,
    async (db, ws) => {
      if (!ws.features.jadwal) throw new AppError("not_found", "Jenis pertemuan tidak ditemukan.");
      const type = await findTypeBySlug(db, typeSlug);
      if (!type) throw new AppError("not_found", "Jenis pertemuan tidak ditemukan.");
      const hosts = await hostIdsOf(db, type.id);
      if (hosts.length === 0) throw new AppError("not_found", "Jenis pertemuan ini belum tersedia.");
      // Jenis berDP: wajib ada layanan pembayaran DAN akun penyedia jasa terverifikasi (aturan #3), dicek SEBELUM menahan slot.
      const deposit = type.depositIdr;
      const manual = opts.payments?.provider.name === "manual";
      if (deposit > 0) {
        if (!opts.payments) throw new AppError("payment_unavailable", "Pembayaran belum tersedia. Hubungi penyedia jasa.");
        if (manual) {
          // ADR 0002: penyedia jasa wajib sudah mengatur minimal satu metode bayar aktif.
          if (!(await hasActivePaymentMethod(db, ws.workspaceId))) throw new AppError("payment_unavailable", "Penyedia jasa belum mengatur metode pembayaran. Hubungi mereka langsung.");
        } else {
          const provider = opts.payments.provider.name;
          const ok = await asWorker(db, (w) => w.select({ id: schema.paymentAccounts.id }).from(schema.paymentAccounts).where(and(eq(schema.paymentAccounts.workspaceId, ws.workspaceId), eq(schema.paymentAccounts.provider, provider), eq(schema.paymentAccounts.kycStatus, "verified"))).limit(1));
          if (ok.length === 0) throw new AppError("payment_unavailable", "Pembayaran online belum aktif untuk penyedia jasa ini.");
        }
      }

      // Catatan klien tamu per email (idempoten terhadap pemesanan serentak).
      const sameGuest = guest.email ? sql`lower(${schema.workspaceClients.email}) = ${guest.email}` : and(isNull(schema.workspaceClients.email), eq(schema.workspaceClients.phone, guest.phone!));
      const findGuest = () => db.select().from(schema.workspaceClients).where(and(isNull(schema.workspaceClients.userId), sameGuest)).limit(1);
      let [client] = await findGuest();
      if (!client) {
        await db.insert(schema.workspaceClients).values({ workspaceId: ws.workspaceId, userId: null, name: guest.name, email: guest.email, phone: guest.phone, consentVersion: LEGAL_VERSION, consentAt: now }).onConflictDoNothing();
        [client] = await findGuest();
      }
      if (!client) throw new AppError("invalid_input", "Tidak dapat memproses permintaan ini.");
      if (client.blocked) throw new AppError("forbidden", "Tidak dapat memproses permintaan ini.");
      // Klien yang diblokir tidak boleh menyiasatinya dengan memesan sebagai tamu: periksa SEMUA catatan klien dengan
      // email yang sama (termasuk yang sudah tertaut ke akun, yang tak terlihat oleh aktor tamu), lewat role worker.
      const blockedElsewhere = await asWorker(db, (w) =>
        w.select({ id: schema.workspaceClients.id }).from(schema.workspaceClients).where(and(eq(schema.workspaceClients.workspaceId, ws.workspaceId), eq(schema.workspaceClients.blocked, true), sameGuest)).limit(1),
      );
      if (blockedElsewhere.length > 0) throw new AppError("forbidden", "Tidak dapat memproses permintaan ini.");

      const host = await pickAvailableHost(db, ws.workspaceId, type.id, hosts, input.startsAt, now);
      // Batas harian per workspace hanya menghitung pemesanan yang LOLOS validasi slot, sehingga tebakan gagal dari
      // penyerang tidak bisa mengunci halaman booking pemilik.
      await consumeRateLimit(pool, rateKey("book-ws", key), { limit: PUBLIC_LIMITS.perWorkspacePerDay, windowSec: 86400, now, message: "Halaman ini sedang menerima terlalu banyak permintaan. Coba lagi nanti." });

      const booking = await insertBooking(db, { workspaceId: ws.workspaceId, meetingTypeId: type.id, memberId: host, clientId: client.id, startsAt: input.startsAt, notes: guest.notes || guest.topic, source: "public_link", tokenHash, now, status: deposit > 0 ? "pending" : "confirmed" });

      const meta: BookingMeta = { workspaceName: ws.name, timezone: ws.timezone, typeTitle: type.title, locationKind: type.locationKind, locationValue: type.locationValue };
      const hook = await opts.hooks?.onBooked?.(db, {
        workspaceId: ws.workspaceId,
        bookingId: booking.id,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        meetingType: { id: type.id, title: type.title, locationKind: type.locationKind, locationValue: type.locationValue },
        hostMemberId: host,
        client: { id: client.id, name: client.name, email: client.email, phone: client.phone },
        topic: guest.topic,
        notes: guest.notes,
        userId: null,
        features: ws.features,
      });
      if (hook?.ticketId) await db.update(schema.bookings).set({ ticketId: hook.ticketId }).where(eq(schema.bookings.id, booking.id));
      // Pembayaran manual dibuat DI transaksi yang sama (atomik dengan booking dan penahanan slot).
      const manualPayment = deposit > 0 && manual ? await createManualPaymentInTx(db, { workspaceId: ws.workspaceId, bookingId: booking.id, amountIdr: deposit, now }) : null;

      await audit(db, { workspaceId: ws.workspaceId, actorUserId: null, action: "booking.created_public", entityType: "booking", entityId: booking.id, diff: { hostMemberId: host, startsAt: booking.startsAt.toISOString() } });

      await sendBookingCreatedNotices(db, { workspace: ws, bookingId: booking.id, startsAt: booking.startsAt, meta, hostMemberId: host, token, guest: { name: guest.name, email: guest.email, phone: guest.phone, topic: guest.topic, notes: guest.notes }, baseUrl: opts.baseUrl, now, awaitingPayment: deposit > 0, holdLabel: manual ? "3 jam" : "30 menit" });

      return { bookingId: booking.id, manageToken: token, startsAt: booking.startsAt, endsAt: booking.endsAt, hostMemberId: host, ticketId: hook?.ticketId ?? null, deposit: deposit > 0 ? { amountIdr: deposit, workspaceId: ws.workspaceId, typeTitle: type.title } : null, manualPaymentId: manualPayment?.paymentId ?? null };
    },
    { bookingTokenHash: tokenHash },
  );

  if (booked.manualPaymentId) return { ...booked, payment: { paymentId: booked.manualPaymentId, checkoutUrl: null as string | null } };
  if (!booked.deposit || !opts.payments) return { ...booked, payment: null as null | { paymentId: string; checkoutUrl: string | null } };
  // Pembayaran dibuat SETELAH transaksi booking selesai (panggilan jaringan tak boleh di dalam transaksi). Bila gagal,
  // createPayment melepas booking lagi (slot kembali) dan melempar payment_failed.
  const created = await createPayment(opts.payments, {
    workspaceId: booked.deposit.workspaceId,
    subjectType: "booking",
    subjectId: booked.bookingId,
    amountIdr: booked.deposit.amountIdr,
    idempotencyKey: `booking:${booked.bookingId}`,
    customer: { name: guest.name, email: guest.email ?? "" },
    description: booked.deposit.typeTitle,
  });
  return { ...booked, payment: { paymentId: created.paymentId, checkoutUrl: created.checkoutUrl as string | null } };
}

/**
 * Hook pembayaran untuk booking: lunas → email "pembayaran diterima" ke tamu dan pemberitahuan ke host;
 * dilepas (gagal/kedaluwarsa) → pengingat dibatalkan dan hook modul (mis. tiket) dijalankan.
 * Dipasang oleh lapisan aplikasi pada `PaymentDeps.hooks`.
 */
async function loadReservation(db: Db, reservationId: string) {
  const [r] = await db
    .select({ id: schema.reservations.id, workspaceId: schema.reservations.workspaceId, resourceName: schema.resources.name, wsName: schema.workspaces.name, wsSlug: schema.workspaces.slug, tz: schema.workspaces.timezone, clientName: schema.workspaceClients.name, clientEmail: schema.workspaceClients.email, startsAt: sql<Date>`lower(${schema.reservations.during})`, endsAt: sql<Date>`upper(${schema.reservations.during})` })
    .from(schema.reservations)
    .innerJoin(schema.resources, eq(schema.resources.id, schema.reservations.resourceId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.reservations.workspaceId))
    .innerJoin(schema.workspaceClients, eq(schema.workspaceClients.id, schema.reservations.clientId))
    .where(eq(schema.reservations.id, reservationId));
  if (!r) return null;
  const day = (d: Date) => new Intl.DateTimeFormat("id-ID", { timeZone: r.tz, day: "numeric", month: "short", year: "numeric" }).format(d);
  const start = new Date(r.startsAt);
  const last = new Date(new Date(r.endsAt).getTime() - 60_000);
  return { ...r, range: day(start) === day(last) ? day(start) : `${day(start)} – ${day(last)}` };
}

export function bookingPaymentHooks(opts: { baseUrl: string; hooks?: BookingHooks }): PaymentHooks {
  const load = async (db: Db, bookingId: string) => {
    const [b] = await db
      .select({ id: schema.bookings.id, workspaceId: schema.bookings.workspaceId, memberId: schema.bookings.memberId, clientId: schema.bookings.clientId, ticketId: schema.bookings.ticketId, startsAt: schema.bookings.startsAt, meetingTypeId: schema.bookings.meetingTypeId })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    return b;
  };
  return {
    async bookingConfirmed(db, p) {
      const b = await load(db, p.subjectId);
      if (!b) return;
      const [ws] = await db.select({ name: schema.workspaces.name, slug: schema.workspaces.slug, timezone: schema.workspaces.timezone }).from(schema.workspaces).where(eq(schema.workspaces.id, b.workspaceId));
      const [mt] = await db.select({ title: schema.meetingTypes.title }).from(schema.meetingTypes).where(eq(schema.meetingTypes.id, b.meetingTypeId));
      const [client] = await db.select({ name: schema.workspaceClients.name, email: schema.workspaceClients.email }).from(schema.workspaceClients).where(eq(schema.workspaceClients.id, b.clientId));
      if (!ws || !mt || !client) return;
      const when = formatWhen(b.startsAt, ws.timezone);
      const base = opts.baseUrl.replace(/\/$/, "");
      if (client.email) {
        await notifyEmails(db, b.workspaceId, [{ to: client.email, subject: `Pembayaran diterima: ${mt.title}`, heading: `Pembayaran diterima, booking Anda dengan ${ws.name} terkonfirmasi`, paragraphs: [`${mt.title} — ${when}`, `Pembayaran Rp${p.amountIdr.toLocaleString("id-ID")} sudah kami terima. Gunakan tautan kelola booking di email sebelumnya untuk mengubah atau membatalkan.`], ctaLabel: "Lihat jadwalin.id", url: base, dedupeKey: `booking:${b.id}:paid` }]);
      }
      await notifyStaff(db, b.workspaceId, { assigneeMemberId: b.memberId }, (to) => ({ to, subject: `Booking berbayar: ${client.name} — ${mt.title}`, heading: `Booking baru (sudah dibayar) dari ${client.name}`, paragraphs: [`${mt.title} — ${when}`, `DP Rp${p.amountIdr.toLocaleString("id-ID")} diterima.`], ctaLabel: "Buka dashboard", url: `${base}/w/${ws.slug}/tiket`, dedupeKey: `booking:${b.id}:host-paid:${to}` }));
    },
    async bookingReleased(db, p) {
      const b = await load(db, p.subjectId);
      if (!b) return;
      await cancelBookingReminders(db, b.workspaceId, b.id);
      await opts.hooks?.onCancelled?.(db, { workspaceId: b.workspaceId, bookingId: b.id, ticketId: b.ticketId });
    },
    async reservationConfirmed(db, p) {
      const r = await loadReservation(db, p.subjectId);
      if (!r) return;
      const base = opts.baseUrl.replace(/\/$/, "");
      if (r.clientEmail) {
        await notifyEmails(db, r.workspaceId, [{ to: r.clientEmail, subject: `DP diterima: ${r.resourceName}`, heading: `DP diterima, sewa ${r.resourceName} terkonfirmasi`, paragraphs: [`${r.range} — ${r.wsName}`, `DP Rp${p.amountIdr.toLocaleString("id-ID")} sudah kami terima dan unit Anda terkunci. Sisa pembayaran dan jaminan diselesaikan langsung dengan penyedia saat pengambilan.`], ctaLabel: "Lihat jadwalin.id", url: base, dedupeKey: `reservation:${r.id}:dp-paid` }]);
      }
      await notifyStaff(db, r.workspaceId, { assigneeMemberId: null }, (to) => ({ to, subject: `DP sewa diterima: ${r.clientName} — ${r.resourceName}`, heading: `DP sewa terverifikasi dari ${r.clientName}`, paragraphs: [`${r.resourceName} · ${r.range}`, `DP Rp${p.amountIdr.toLocaleString("id-ID")} dikonfirmasi; pesanan terkonfirmasi.`], ctaLabel: "Buka pesanan sewa", url: `${base}/w/${r.wsSlug}/sewa`, dedupeKey: `reservation:${r.id}:dp-host:${to}` }));
    },
    async reservationReleased(db, p) {
      const r = await loadReservation(db, p.subjectId);
      if (!r?.clientEmail) return;
      await notifyEmails(db, r.workspaceId, [{ to: r.clientEmail, subject: `Pesanan sewa dilepas: ${r.resourceName}`, heading: "Waktu pembayaran DP habis", paragraphs: [`${r.resourceName} · ${r.range}`, "DP belum kami terima tepat waktu sehingga unit dilepas kembali. Silakan ajukan sewa lagi bila masih berminat."], ctaLabel: "Lihat jadwalin.id", url: opts.baseUrl.replace(/\/$/, ""), dedupeKey: `reservation:${r.id}:dp-released` }]);
    },
  };
}

// --- Kelola booking lewat token ------------------------------------------------------------------

export interface ManagedBooking {
  id: string;
  workspaceId: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  memberId: string;
  clientId: string;
  ticketId: string | null;
  meetingTypeId: string;
  type: { title: string; slug: string; durationMin: number; bufferBeforeMin: number; bufferAfterMin: number; locationKind: "link" | "phone" | "in_person"; locationValue: string | null };
  workspace: { name: string; slug: string; timezone: string; contactPhone: string | null };
  /** Masih bisa dibatalkan/diubah: booking aktif dan belum mulai. */
  canChange: boolean;
  /** Tamu tanpa email: kabar hanya lewat halaman booking dan penyedia jasa (ADR 0004). */
  noEmail: boolean;
  clientName: string;
}

async function loadByToken(db: Db, tokenHash: string, now: Date): Promise<ManagedBooking | null> {
  return loadBooking(db, eq(schema.bookings.cancelTokenHash, tokenHash), now);
}

/** Booking (dalam bentuk kelola) menurut id; konteks (RLS) menentukan siapa yang boleh melihatnya. */
export async function loadBookingById(db: Db, bookingId: string, now: Date): Promise<ManagedBooking | null> {
  return loadBooking(db, eq(schema.bookings.id, bookingId), now);
}

async function loadBooking(db: Db, cond: ReturnType<typeof eq>, now: Date): Promise<ManagedBooking | null> {
  const [r] = await db
    .select({
      id: schema.bookings.id,
      workspaceId: schema.bookings.workspaceId,
      status: schema.bookings.status,
      startsAt: schema.bookings.startsAt,
      endsAt: schema.bookings.endsAt,
      memberId: schema.bookings.memberId,
      clientId: schema.bookings.clientId,
      ticketId: schema.bookings.ticketId,
      meetingTypeId: schema.bookings.meetingTypeId,
      typeTitle: schema.meetingTypes.title,
      typeSlug: schema.meetingTypes.slug,
      durationMin: schema.meetingTypes.durationMin,
      bufferBeforeMin: schema.meetingTypes.bufferBeforeMin,
      bufferAfterMin: schema.meetingTypes.bufferAfterMin,
      locationKind: schema.meetingTypes.locationKind,
      locationValue: schema.meetingTypes.locationValue,
      wsName: schema.workspaces.name,
      wsSlug: schema.workspaces.slug,
      wsTimezone: schema.workspaces.timezone,
      wsPhone: schema.workspaces.contactPhone,
    })
    .from(schema.bookings)
    .innerJoin(schema.meetingTypes, eq(schema.meetingTypes.id, schema.bookings.meetingTypeId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.bookings.workspaceId))
    .where(cond)
    .limit(1);
  if (!r) return null;
  const contact = await clientContact(db, r.clientId);
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    status: r.status,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    memberId: r.memberId,
    clientId: r.clientId,
    ticketId: r.ticketId,
    meetingTypeId: r.meetingTypeId,
    type: { title: r.typeTitle, slug: r.typeSlug, durationMin: r.durationMin, bufferBeforeMin: r.bufferBeforeMin, bufferAfterMin: r.bufferAfterMin, locationKind: r.locationKind, locationValue: r.locationValue },
    workspace: { name: r.wsName, slug: r.wsSlug, timezone: r.wsTimezone, contactPhone: r.wsPhone },
    canChange: (ACTIVE as readonly string[]).includes(r.status) && r.startsAt.getTime() > now.getTime(),
    noEmail: contact.email === null,
    clientName: contact.name,
  };
}

/** Booking milik pemegang token (yang ada di emailnya). Token acak/salah → null, tanpa petunjuk apa pun. */
export async function getBookingByToken(pool: pg.Pool, token: string, now = new Date()): Promise<ManagedBooking | null> {
  if (!token || token.length > 200) return null;
  const tokenHash = hashToken(token);
  return withTenant(pool, { userId: NIL_UUID, actor: "public", bookingTokenHash: tokenHash }, (db) => loadByToken(db, tokenHash, now));
}

/** Status pembayaran DP untuk pemegang tautan booking (null bila booking tanpa pembayaran). RLS: hanya lewat token booking. */
export async function getBookingPayment(pool: pg.Pool, token: string): Promise<{ status: string; amountIdr: number; checkoutUrl: string | null; expiresAt: Date } | null> {
  if (!token || token.length > 200) return null;
  const tokenHash = hashToken(token);
  return withTenant(pool, { userId: NIL_UUID, actor: "public", bookingTokenHash: tokenHash }, async (db) => {
    const [b] = await db.select({ id: schema.bookings.id }).from(schema.bookings).where(eq(schema.bookings.cancelTokenHash, tokenHash)).limit(1);
    if (!b) return null;
    const [p] = await db.select({ status: schema.payments.status, amountIdr: schema.payments.amountIdr, checkoutUrl: schema.payments.checkoutUrl, expiresAt: schema.payments.expiresAt }).from(schema.payments).where(and(eq(schema.payments.subjectType, "booking"), eq(schema.payments.subjectId, b.id))).orderBy(sql`${schema.payments.createdAt} desc`).limit(1);
    return p ?? null;
  });
}

export async function clientContact(db: Db, clientId: string): Promise<{ email: string | null; name: string }> {
  return asWorker(db, async (w) => {
    const [c] = await w.select({ email: schema.workspaceClients.email, name: schema.workspaceClients.name }).from(schema.workspaceClients).where(eq(schema.workspaceClients.id, clientId)).limit(1);
    return c ?? { email: null, name: "Tamu" };
  });
}

export async function manage<T>(pool: pg.Pool, token: string, now: Date, fn: (db: Db, b: ManagedBooking, tokenHash: string) => Promise<T>): Promise<T> {
  const tokenHash = hashToken(token);
  const found = await getBookingByToken(pool, token, now);
  if (!found) throw new AppError("not_found", "Booking tidak ditemukan.");
  await consumeRateLimit(pool, rateKey("manage", tokenHash), { limit: PUBLIC_LIMITS.manageActionsPerTokenPerDay, windowSec: 86400, now });
  return withTenant(pool, { userId: NIL_UUID, workspaceId: found.workspaceId, actor: "public", bookingTokenHash: tokenHash }, (db) => fn(db, found, tokenHash));
}

/** Pengaturan perubahan usaha (batas waktu dan mode ubah jadwal) + DP yang sudah terbayar untuk satu booking. */
export async function loadChangeContext(db: Db, b: { id: string; workspaceId: string }): Promise<{ rescheduleMode: "auto" | "approval"; changeMinHours: number; paid: { paymentId: string; amountIdr: number } | null }> {
  return asWorker(db, async (w) => {
    const [ws] = await w.select({ mode: schema.workspaces.rescheduleMode, minHours: schema.workspaces.changeMinHours }).from(schema.workspaces).where(eq(schema.workspaces.id, b.workspaceId)).limit(1);
    const [p] = await w
      .select({ id: schema.payments.id, amountIdr: schema.payments.amountIdr })
      .from(schema.payments)
      .where(and(eq(schema.payments.subjectType, "booking"), eq(schema.payments.subjectId, b.id), eq(schema.payments.provider, "manual"), eq(schema.payments.status, "paid")))
      .limit(1);
    return { rescheduleMode: ws?.mode === "approval" ? "approval" : "auto", changeMinHours: ws?.minHours ?? 0, paid: p ? { paymentId: p.id, amountIdr: p.amountIdr } : null };
  });
}

/** Di luar batas waktu usaha (mis. "paling lambat 24 jam sebelum")? Pelanggan harus menghubungi penyedia jasa. */
export function assertWithinChangeWindow(b: { startsAt: Date }, minHours: number, now: Date): void {
  if (minHours > 0 && b.startsAt.getTime() - now.getTime() < minHours * 3_600_000) {
    throw new AppError("invalid_input", `Perubahan hanya bisa dilakukan paling lambat ${minHours} jam sebelum jadwal. Hubungi penyedia jasa.`);
  }
}

/** Membatalkan booking (tanpa pemeriksaan hak): dipakai pembatalan langsung pelanggan dan penyelesaian refund oleh penyedia. */
export async function applyCancel(db: Db, b: ManagedBooking, opts: { baseUrl: string; now: Date; hooks?: BookingHooks; by: "guest" | "host"; tokenHash?: string }): Promise<void> {
  const where = opts.tokenHash
    ? and(eq(schema.bookings.id, b.id), eq(schema.bookings.cancelTokenHash, opts.tokenHash), inArray(schema.bookings.status, [...ACTIVE]))
    : and(eq(schema.bookings.id, b.id), inArray(schema.bookings.status, [...ACTIVE]));
  const done = await db.update(schema.bookings).set({ status: "cancelled" }).where(where).returning({ id: schema.bookings.id });
  if (done.length === 0) throw new AppError("invalid_input", "Booking ini sudah dibatalkan.");
  await cancelBookingReminders(db, b.workspaceId, b.id);
  await cancelOpenManualPayment(db, { type: "booking", id: b.id }, "api", opts.now);
  await opts.hooks?.onCancelled?.(db, { workspaceId: b.workspaceId, bookingId: b.id, ticketId: b.ticketId });
  await audit(db, { workspaceId: b.workspaceId, actorUserId: null, action: opts.by === "guest" ? "booking.cancelled_by_guest" : "booking.cancelled_by_host", entityType: "booking", entityId: b.id });
  const who = await clientContact(db, b.clientId);
  const when = formatWhen(b.startsAt, b.workspace.timezone);
  const base = opts.baseUrl.replace(/\/$/, "");
  await notifyEmails(db, b.workspaceId, who.email ? [{ to: who.email, subject: `Booking dibatalkan: ${b.type.title}`, heading: "Booking Anda dibatalkan", paragraphs: [`${b.type.title} — ${when}`, `Anda bisa memesan jadwal baru kapan saja di jadwalin.id/${b.workspace.slug}.`], ctaLabel: "Pesan jadwal baru", url: `${base}/${b.workspace.slug}`, dedupeKey: `booking:${b.id}:cancelled:${opts.by}` }] : []);
  if (opts.by === "guest") {
    await notifyStaff(db, b.workspaceId, { assigneeMemberId: b.memberId }, (to) => ({ to, subject: `Booking dibatalkan: ${who.name}`, heading: `${who.name} membatalkan booking`, paragraphs: [`${b.type.title} — ${when}`], ctaLabel: "Buka dashboard", url: `${base}/w/${b.workspace.slug}/tiket`, dedupeKey: `booking:${b.id}:cancelled:host:${to}` }));
  }
}

export async function cancelBookingByToken(pool: pg.Pool, token: string, opts: { baseUrl: string; now?: Date; hooks?: BookingHooks }) {
  const now = opts.now ?? new Date();
  return manage(pool, token, now, async (db, b, tokenHash) => {
    if (!b.canChange) throw new AppError("invalid_input", b.status === "cancelled" ? "Booking ini sudah dibatalkan." : "Booking ini sudah tidak bisa diubah.");
    const ctx = await loadChangeContext(db, b);
    // DP yang sudah dibayar: pembatalan harus disetujui penyedia dan dananya dikembalikan (ADR 0004), bukan langsung.
    if (ctx.paid) throw new AppError("invalid_input", "DP booking ini sudah dibayar. Ajukan pembatalan agar penyedia jasa bisa menyetujuinya dan mengembalikan dana.");
    assertWithinChangeWindow(b, ctx.changeMinHours, now);
    await applyCancel(db, b, { baseUrl: opts.baseUrl, now, hooks: opts.hooks, by: "guest", tokenHash });
  });
}

/**
 * Memindahkan booking ke waktu baru (tanpa pemeriksaan hak): host sama diutamakan; bila tak kosong, host lain jenis ini.
 * Dipakai ubah jadwal langsung pelanggan dan persetujuan oleh penyedia.
 */
export async function applyReschedule(db: Db, b: ManagedBooking, newStartsAt: Date, opts: { baseUrl: string; now: Date; hooks?: BookingHooks; by: "guest" | "host"; token?: string; tokenHash?: string }) {
  const hosts = await hostIdsOf(db, b.meetingTypeId);
  const candidates = [b.memberId, ...hosts.filter((h) => h !== b.memberId)];
  let host: string | null = null;
  let slot: Slot | null = null;
  for (const memberId of candidates) {
    const slots = await findMemberSlots(db, b.workspaceId, { meetingTypeId: b.meetingTypeId, memberId, now: opts.now, ignoreBookingId: b.id });
    const hit = slots.find((s) => s.start.getTime() === newStartsAt.getTime());
    if (hit) {
      host = memberId;
      slot = hit;
      break;
    }
  }
  if (!host || !slot) throw new AppError("slot_unavailable", "Jadwal itu sudah tidak tersedia. Pilih waktu lain.");
  const from = new Date(slot.start.getTime() - b.type.bufferBeforeMin * MS_MIN);
  const to = new Date(slot.end.getTime() + b.type.bufferAfterMin * MS_MIN);
  try {
    const where = opts.tokenHash
      ? and(eq(schema.bookings.id, b.id), eq(schema.bookings.cancelTokenHash, opts.tokenHash), inArray(schema.bookings.status, [...ACTIVE]))
      : and(eq(schema.bookings.id, b.id), inArray(schema.bookings.status, [...ACTIVE]));
    const done = await db.update(schema.bookings).set({ during: `[${from.toISOString()},${to.toISOString()})`, startsAt: slot.start, endsAt: slot.end, memberId: host }).where(where).returning({ id: schema.bookings.id });
    if (done.length === 0) throw new AppError("invalid_input", "Booking ini sudah tidak aktif.");
  } catch (error) {
    if (isExclusionViolation(error, "bookings_no_overlap")) throw new AppError("slot_unavailable", "Jadwal itu baru saja diambil. Pilih waktu lain.");
    throw error;
  }
  await cancelBookingReminders(db, b.workspaceId, b.id);
  await opts.hooks?.onRescheduled?.(db, { workspaceId: b.workspaceId, bookingId: b.id, ticketId: b.ticketId, startsAt: slot.start });
  await audit(db, { workspaceId: b.workspaceId, actorUserId: null, action: opts.by === "guest" ? "booking.rescheduled_by_guest" : "booking.rescheduled_by_host", entityType: "booking", entityId: b.id, diff: { from: b.startsAt.toISOString(), to: slot.start.toISOString(), hostMemberId: host } });
  const who = await clientContact(db, b.clientId);
  const meta: BookingMeta = { workspaceName: b.workspace.name, timezone: b.workspace.timezone, typeTitle: b.type.title, locationKind: b.type.locationKind, locationValue: b.type.locationValue };
  const base = opts.baseUrl.replace(/\/$/, "");
  // Email berisi tautan kelola hanya bila token mentah ada (alur pelanggan); alur penyedia memakai tautan kode booking.
  if (who.email && opts.token) await notifyEmails(db, b.workspaceId, guestNotices(b.id, opts.token, who.email, slot.start, meta, opts.baseUrl, "rescheduled", opts.now));
  else if (who.email) await notifyEmails(db, b.workspaceId, [{ to: who.email, subject: `Jadwal diubah: ${b.type.title}`, heading: `Jadwal baru Anda dengan ${b.workspace.name}`, paragraphs: [`${b.type.title} — ${formatWhen(slot.start, b.workspace.timezone)}`, `Kode booking: ${bookingCode(b.id)}`], ctaLabel: "Lihat booking", url: `${base}/booking/cari?u=${b.workspace.slug}&kode=${bookingCode(b.id)}`, dedupeKey: `booking:${b.id}:rescheduled:${slot.start.getTime()}` }]);
  if (opts.by === "guest") {
    await notifyStaff(db, b.workspaceId, { assigneeMemberId: host }, (email) => ({ to: email, subject: `Jadwal diubah: ${who.name}`, heading: `${who.name} mengubah jadwal`, paragraphs: [`${b.type.title}: ${formatWhen(b.startsAt, b.workspace.timezone)} → ${formatWhen(slot!.start, b.workspace.timezone)}`], ctaLabel: "Buka dashboard", url: `${base}/w/${b.workspace.slug}/tiket`, dedupeKey: `booking:${b.id}:rescheduled:host:${slot!.start.getTime()}:${email}` }));
  }
  return { startsAt: slot.start, endsAt: slot.end, hostMemberId: host };
}

export async function rescheduleBookingByToken(pool: pg.Pool, token: string, newStartsAt: Date, opts: { baseUrl: string; now?: Date; hooks?: BookingHooks }) {
  const now = opts.now ?? new Date();
  if (Number.isNaN(newStartsAt.getTime())) throw new AppError("invalid_input", "Pilih waktu terlebih dulu.");
  return manage(pool, token, now, async (db, b, tokenHash) => {
    if (!b.canChange) throw new AppError("invalid_input", "Booking ini sudah tidak bisa diubah.");
    const ctx = await loadChangeContext(db, b);
    if (ctx.rescheduleMode === "approval") throw new AppError("invalid_input", "Usaha ini meminta persetujuan untuk mengubah jadwal. Kirim permintaan ubah jadwal.");
    assertWithinChangeWindow(b, ctx.changeMinHours, now);
    return applyReschedule(db, b, newStartsAt, { baseUrl: opts.baseUrl, now, hooks: opts.hooks, by: "guest", token, tokenHash });
  });
}

/** Slot untuk mengubah jadwal sebuah booking (booking itu sendiri tidak dianggap menghalangi). */
export async function listRescheduleSlots(pool: pg.Pool, token: string, now = new Date()): Promise<Slot[] | null> {
  const b = await getBookingByToken(pool, token, now);
  if (!b || !b.canChange) return null;
  return withTenant(pool, { userId: NIL_UUID, workspaceId: b.workspaceId, actor: "public", bookingTokenHash: hashToken(token) }, async (db) => {
    const hosts = await hostIdsOf(db, b.meetingTypeId);
    return unionSlots(db, b.workspaceId, b.meetingTypeId, hosts, now, b.id);
  });
}
