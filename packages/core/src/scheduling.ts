import { asWorker, schema, type Db } from "@jadwalin/db";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError, isExclusionViolation, isUniqueViolation } from "./errors";
import { requireFeature } from "./features";
import { hashToken, newToken } from "./tokens";
import { normalizePhone } from "./phone";
import {
  computeSlots,
  isWorkspaceTimezone,
  localDateOf,
  parseHM,
  TIMEZONE_OFFSET_MIN,
  type BusyRange,
  type DateOverride,
  type Slot,
  type WeeklyRule,
} from "./slots";
import { audit, withWorkspace, type Actor, type WorkspaceAccess } from "./workspace";

const MS_MIN = 60_000;

// --- Jenis pertemuan -----------------------------------------------------------------------

export interface MeetingTypeInput {
  slug: string;
  title: string;
  durationMin: number;
  slotStepMin?: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  minNoticeMin?: number;
  maxDaysAhead?: number;
  locationKind: "link" | "phone" | "in_person";
  locationValue?: string;
  /** DP dalam Rupiah (integer). 0/kosong = gratis. Bila > 0, minimal Rp1.000. */
  depositIdr?: number;
}

function intInRange(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new AppError("invalid_input", `${label} harus bilangan bulat ${min}–${max}.`);
  }
  return v;
}

function validateLocation(kind: MeetingTypeInput["locationKind"], raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (kind === "link") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new AppError("invalid_input", "Link meeting harus berupa URL yang valid (https://…).");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new AppError("invalid_input", "Link meeting harus diawali https://.");
    }
    return url.toString();
  }
  if (kind === "phone") return normalizePhone(value);
  return value.slice(0, 300);
}

export async function createMeetingType(pool: pg.Pool, actor: Actor, input: MeetingTypeInput) {
  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})[a-z0-9]$/.test(slug)) {
    throw new AppError("invalid_slug", "Kode jenis pertemuan: 2–40 karakter huruf kecil, angka, tanda hubung.");
  }
  const title = input.title.trim();
  if (title.length < 2 || title.length > 80) throw new AppError("invalid_input", "Judul 2–80 karakter.");
  const values = {
    slug,
    title,
    durationMin: intInRange(input.durationMin, 30, 5, 480, "Durasi (menit)"),
    slotStepMin: intInRange(input.slotStepMin, 30, 5, 240, "Interval slot (menit)"),
    bufferBeforeMin: intInRange(input.bufferBeforeMin, 0, 0, 120, "Buffer sebelum"),
    bufferAfterMin: intInRange(input.bufferAfterMin, 0, 0, 120, "Buffer sesudah"),
    minNoticeMin: intInRange(input.minNoticeMin, 60, 0, 60 * 24 * 30, "Pemberitahuan minimum"),
    maxDaysAhead: intInRange(input.maxDaysAhead, 30, 1, 365, "Batas hari ke depan"),
    locationKind: input.locationKind,
    locationValue: validateLocation(input.locationKind, input.locationValue),
    depositIdr: intInRange(input.depositIdr, 0, 0, 100_000_000, "DP (Rupiah)"),
  };
  if (values.depositIdr > 0 && values.depositIdr < 1000) throw new AppError("invalid_input", "DP minimal Rp1.000 (atau 0 untuk gratis).");
  // Beban hitung per halaman publik ~ hari ke depan x slot per hari: batasi kombinasi ekstrem.
  if ((values.maxDaysAhead * 24 * 60) / values.slotStepMin > 20_000) {
    throw new AppError("invalid_input", "Kombinasi interval slot dan rentang hari terlalu rapat. Perbesar interval atau perkecil rentang hari.");
  }
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    await requireFeature(db, access, "jadwal");
    if (values.depositIdr > 0) await requireFeature(db, access, "pembayaran");
    try {
      const [row] = await db
        .insert(schema.meetingTypes)
        .values({ workspaceId: access.workspaceId, ...values })
        .returning({ id: schema.meetingTypes.id });
      await db.insert(schema.meetingTypeHosts).values({ workspaceId: access.workspaceId, meetingTypeId: row!.id, memberId: access.memberId });
      await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "meeting_type.created", entityType: "meeting_type", entityId: row!.id, diff: values });
      return row!;
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError("slug_taken", "Kode jenis pertemuan sudah dipakai.");
      throw error;
    }
  });
}

/**
 * Mengubah layanan yang sudah ada (nama, durasi, DP, lokasi). Kode link tidak berubah supaya tautan yang sudah dibagikan tetap hidup.
 * Booking yang sudah dibuat tidak terpengaruh (waktu dan nominalnya sudah tercatat).
 */
export async function updateMeetingType(
  pool: pg.Pool,
  actor: Actor,
  meetingTypeId: string,
  input: { title: string; durationMin: number; depositIdr?: number; locationKind: MeetingTypeInput["locationKind"]; locationValue?: string },
) {
  const title = input.title.trim();
  if (title.length < 2 || title.length > 80) throw new AppError("invalid_input", "Judul 2–80 karakter.");
  const values = {
    title,
    durationMin: intInRange(input.durationMin, 30, 5, 480, "Durasi (menit)"),
    locationKind: input.locationKind,
    locationValue: validateLocation(input.locationKind, input.locationValue),
    depositIdr: intInRange(input.depositIdr, 0, 0, 100_000_000, "DP (Rupiah)"),
  };
  if (values.depositIdr > 0 && values.depositIdr < 1000) throw new AppError("invalid_input", "DP minimal Rp1.000 (atau 0 untuk gratis).");
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    if (values.depositIdr > 0) await requireFeature(db, access, "pembayaran");
    const updated = await db.update(schema.meetingTypes).set(values).where(eq(schema.meetingTypes.id, meetingTypeId)).returning({ id: schema.meetingTypes.id });
    if (updated.length === 0) throw new AppError("not_found", "Jenis pertemuan tidak ditemukan.");
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "meeting_type.updated", entityType: "meeting_type", entityId: meetingTypeId, diff: values });
  });
}

export async function listMeetingTypes(pool: pg.Pool, actor: Actor) {
  return withWorkspace(pool, actor, "staff", (db) =>
    db.select().from(schema.meetingTypes).orderBy(asc(schema.meetingTypes.title)),
  );
}

export async function setMeetingTypeActive(pool: pg.Pool, actor: Actor, meetingTypeId: string, active: boolean) {
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    const updated = await db
      .update(schema.meetingTypes)
      .set({ active })
      .where(eq(schema.meetingTypes.id, meetingTypeId))
      .returning({ id: schema.meetingTypes.id });
    if (updated.length === 0) throw new AppError("not_found", "Jenis pertemuan tidak ditemukan.");
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: active ? "meeting_type.activated" : "meeting_type.deactivated", entityType: "meeting_type", entityId: meetingTypeId });
  });
}

// --- Ketersediaan --------------------------------------------------------------------------

/** Anggota boleh mengatur ketersediaannya sendiri; mengatur milik orang lain butuh admin. */
async function resolveMember(db: Db, access: WorkspaceAccess, memberId: string | undefined): Promise<string> {
  const target = memberId ?? access.memberId;
  if (target !== access.memberId && access.role === "staff") {
    throw new AppError("forbidden", "Anda hanya bisa mengatur ketersediaan Anda sendiri.");
  }
  const [row] = await db.select({ id: schema.workspaceMembers.id }).from(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, target)).limit(1);
  if (!row) throw new AppError("not_found", "Anggota tidak ditemukan.");
  return target;
}

export function validateRules(rules: readonly WeeklyRule[]): void {
  const byDay = new Map<number, [number, number][]>();
  for (const r of rules) {
    if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) throw new AppError("invalid_input", "Hari harus 0–6.");
    let s: number;
    let e: number;
    try {
      s = parseHM(r.start);
      e = parseHM(r.end);
    } catch {
      throw new AppError("invalid_input", "Format jam harus HH:MM.");
    }
    if (e <= s) throw new AppError("invalid_input", "Jam selesai harus setelah jam mulai.");
    byDay.set(r.weekday, [...(byDay.get(r.weekday) ?? []), [s, e]]);
  }
  for (const list of byDay.values()) {
    const sorted = [...list].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]![0] < sorted[i - 1]![1]) throw new AppError("invalid_input", "Jam pada hari yang sama tidak boleh tumpang tindih.");
    }
  }
}

/** Mengganti seluruh jam rutin mingguan seorang anggota. */
export async function setWeeklyAvailability(pool: pg.Pool, actor: Actor, input: { memberId?: string; rules: WeeklyRule[] }) {
  validateRules(input.rules);
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const memberId = await resolveMember(db, access, input.memberId);
    await db.delete(schema.availabilityRules).where(eq(schema.availabilityRules.memberId, memberId));
    if (input.rules.length > 0) {
      await db.insert(schema.availabilityRules).values(
        input.rules.map((r) => ({ workspaceId: access.workspaceId, memberId, weekday: r.weekday, startTime: r.start, endTime: r.end })),
      );
    }
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "availability.replaced", entityType: "workspace_member", entityId: memberId, diff: { rules: input.rules } });
  });
}

export async function getWeeklyAvailability(pool: pg.Pool, actor: Actor, memberId?: string): Promise<WeeklyRule[]> {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const id = memberId ?? access.memberId;
    const rows = await db
      .select()
      .from(schema.availabilityRules)
      .where(eq(schema.availabilityRules.memberId, id))
      .orderBy(asc(schema.availabilityRules.weekday), asc(schema.availabilityRules.startTime));
    return rows.map((r) => ({ weekday: r.weekday, start: r.startTime.slice(0, 5), end: r.endTime.slice(0, 5) }));
  });
}

export async function addOverride(pool: pg.Pool, actor: Actor, input: { memberId?: string; date: string; kind: "blocked" | "extra"; start?: string; end?: string }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(input.date))) {
    throw new AppError("invalid_input", "Tanggal harus berformat YYYY-MM-DD.");
  }
  const start = input.start?.trim() || null;
  const end = input.end?.trim() || null;
  if ((start === null) !== (end === null)) throw new AppError("invalid_input", "Isi jam mulai dan selesai, atau kosongkan keduanya.");
  if (input.kind === "extra" && start === null) throw new AppError("invalid_input", "Jam tambahan wajib punya jam mulai dan selesai.");
  if (start && end) {
    try {
      if (parseHM(end) <= parseHM(start)) throw new AppError("invalid_input", "Jam selesai harus setelah jam mulai.");
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("invalid_input", "Format jam harus HH:MM.");
    }
  }
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const memberId = await resolveMember(db, access, input.memberId);
    const [row] = await db
      .insert(schema.availabilityOverrides)
      .values({ workspaceId: access.workspaceId, memberId, date: input.date, kind: input.kind, startTime: start, endTime: end })
      .returning({ id: schema.availabilityOverrides.id });
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "availability.override_added", entityType: "availability_override", entityId: row!.id, diff: { ...input, memberId } });
    return row!;
  });
}

export async function removeOverride(pool: pg.Pool, actor: Actor, overrideId: string) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const [row] = await db.select().from(schema.availabilityOverrides).where(eq(schema.availabilityOverrides.id, overrideId)).limit(1);
    if (!row) throw new AppError("not_found", "Pengecualian tidak ditemukan.");
    await resolveMember(db, access, row.memberId);
    await db.delete(schema.availabilityOverrides).where(eq(schema.availabilityOverrides.id, overrideId));
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "availability.override_removed", entityType: "availability_override", entityId: overrideId });
  });
}

export async function listOverrides(pool: pg.Pool, actor: Actor, opts: { memberId?: string; now?: Date } = {}) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const ws = await loadTimezone(db, access.workspaceId);
    const today = localDateOf((opts.now ?? new Date()).getTime(), TIMEZONE_OFFSET_MIN[ws]);
    return db
      .select()
      .from(schema.availabilityOverrides)
      .where(and(eq(schema.availabilityOverrides.memberId, opts.memberId ?? access.memberId), gte(schema.availabilityOverrides.date, today)))
      .orderBy(asc(schema.availabilityOverrides.date));
  });
}

// --- Slot & booking ------------------------------------------------------------------------

async function loadTimezone(db: Db, workspaceId: string) {
  const [ws] = await db.select({ timezone: schema.workspaces.timezone }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  if (!ws || !isWorkspaceTimezone(ws.timezone)) throw new AppError("invalid_input", "Zona waktu halaman tidak didukung.");
  return ws.timezone;
}

export interface MemberSlotQuery {
  meetingTypeId: string;
  memberId: string;
  now?: Date;
  /** Abaikan booking ini saat menghitung bentrok (mengubah jadwal booking yang sama). */
  ignoreBookingId?: string;
}

/**
 * Slot kosong satu anggota untuk satu jenis pertemuan. Hanya membaca, dan hanya memakai tabel yang boleh dibaca
 * staf, klien, maupun tamu (jenis aktif, ketersediaan, rentang booking aktif); dipakai ketiganya.
 */
export async function findMemberSlots(db: Db, workspaceId: string, q: MemberSlotQuery): Promise<Slot[]> {
  const now = q.now ?? new Date();
  const [mt] = await db.select().from(schema.meetingTypes).where(eq(schema.meetingTypes.id, q.meetingTypeId)).limit(1);
  if (!mt || !mt.active) throw new AppError("not_found", "Jenis pertemuan tidak ditemukan.");
  const timezone = await loadTimezone(db, workspaceId);

  const rules = await db.select().from(schema.availabilityRules).where(eq(schema.availabilityRules.memberId, q.memberId));
  const overrides = await db.select().from(schema.availabilityOverrides).where(eq(schema.availabilityOverrides.memberId, q.memberId));
  const horizon = new Date(now.getTime() + (mt.maxDaysAhead + 2) * 86_400_000);
  const busyRows = await db.execute<{ s: Date; e: Date }>(sql`
    SELECT lower(during) AS s, upper(during) AS e FROM bookings
    WHERE member_id = ${q.memberId} AND status IN ('pending', 'confirmed')
      ${q.ignoreBookingId ? sql`AND id <> ${q.ignoreBookingId}` : sql``}
      AND during && tstzrange(${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz, ${horizon.toISOString()}::timestamptz)`);
  const busy: BusyRange[] = busyRows.rows.map((r) => ({ start: new Date(r.s), end: new Date(r.e) }));

  return computeSlots({
    now,
    timezone,
    durationMin: mt.durationMin,
    bufferBeforeMin: mt.bufferBeforeMin,
    bufferAfterMin: mt.bufferAfterMin,
    minNoticeMin: mt.minNoticeMin,
    maxDaysAhead: mt.maxDaysAhead,
    stepMin: mt.slotStepMin,
    rules: rules.map((r) => ({ weekday: r.weekday, start: r.startTime, end: r.endTime })),
    overrides: overrides.map<DateOverride>((o) => ({ date: o.date, kind: o.kind, start: o.startTime, end: o.endTime })),
    busy,
  });
}

/** Slot yang saat ini tersedia untuk satu anggota (default: pemanggil). Dipakai pratinjau dan validasi booking staf. */
export async function findSlots(db: Db, access: WorkspaceAccess, opts: { meetingTypeId: string; memberId?: string; now?: Date }): Promise<Slot[]> {
  return findMemberSlots(db, access.workspaceId, { meetingTypeId: opts.meetingTypeId, memberId: opts.memberId ?? access.memberId, now: opts.now });
}

export async function listAvailableSlots(pool: pg.Pool, actor: Actor, opts: { meetingTypeId: string; memberId?: string; now?: Date }) {
  return withWorkspace(pool, actor, "staff", (db, access) => findSlots(db, access, opts));
}

export type BookingSource = "staff" | "client_portal" | "public_link";

export interface InsertBookingInput {
  workspaceId: string;
  meetingTypeId: string;
  memberId: string;
  clientId: string;
  startsAt: Date;
  ticketId?: string | null;
  notes?: string | null;
  source: BookingSource;
  /** Hash token kelola (token mentah dibuat pemanggil dan hanya dikirim lewat email). */
  tokenHash: string;
  /** 'pending' menahan slot sambil menunggu pembayaran DP (ADR 0001). Bawaan 'confirmed'. */
  status?: "confirmed" | "pending";
  now?: Date;
}

/**
 * Inti pembuatan booking, TANPA pemeriksaan izin (pemanggil bertanggung jawab atas otorisasi). Slot dihitung ulang
 * dan harus cocok persis; keputusan akhir ada di constraint exclusion database, jadi dua permintaan serentak ke slot yang
 * sama tidak mungkin lolos dua-duanya. Tanpa RETURNING agar aktor yang tak boleh membaca bookings tetap bisa menulis.
 */
export async function insertBooking(db: Db, input: InsertBookingInput) {
  const slots = await findMemberSlots(db, input.workspaceId, { meetingTypeId: input.meetingTypeId, memberId: input.memberId, now: input.now });
  const slot = slots.find((s) => s.start.getTime() === input.startsAt.getTime());
  if (!slot) throw new AppError("slot_unavailable", "Jadwal itu sudah tidak tersedia. Pilih waktu lain.");
  const [mt] = await db.select().from(schema.meetingTypes).where(eq(schema.meetingTypes.id, input.meetingTypeId)).limit(1);
  const from = new Date(slot.start.getTime() - mt!.bufferBeforeMin * MS_MIN);
  const to = new Date(slot.end.getTime() + mt!.bufferAfterMin * MS_MIN);
  const id = randomUUID();
  try {
    // Bila constraint menolak, galat dilempar dan transaksi pemanggil dibatalkan seluruhnya.
    await db.insert(schema.bookings).values({
      id,
      workspaceId: input.workspaceId,
      meetingTypeId: input.meetingTypeId,
      memberId: input.memberId,
      clientId: input.clientId,
      ticketId: input.ticketId ?? null,
      during: `[${from.toISOString()},${to.toISOString()})`,
      startsAt: slot.start,
      endsAt: slot.end,
      status: input.status ?? "confirmed",
      source: input.source,
      cancelTokenHash: input.tokenHash,
      notes: input.notes?.trim() || null,
    });
  } catch (error) {
    if (isExclusionViolation(error, "bookings_no_overlap")) throw new AppError("slot_unavailable", "Jadwal itu baru saja diambil. Pilih waktu lain.");
    throw error;
  }
  return { id, startsAt: slot.start, endsAt: slot.end, meetingType: mt! };
}

export interface BookingInput {
  meetingTypeId: string;
  memberId?: string;
  clientId: string;
  startsAt: Date;
  ticketId?: string;
  notes?: string;
  now?: Date;
  source?: BookingSource;
}

/** Booking oleh staf (atau atas nama klien terdaftar). */
export async function createBooking(pool: pg.Pool, actor: Actor, input: BookingInput) {
  return withWorkspace(pool, actor, "staff", (db, access) => createBookingIn(db, access, actor.userId, input));
}

/** Versi dalam-transaksi: dipakai modul (mis. tiket) agar booking dan tautannya commit bersama. */
export async function createBookingIn(db: Db, access: WorkspaceAccess, actorUserId: string, input: BookingInput) {
  const memberId = await resolveMember(db, access, input.memberId);
  // FK tidak melewati RLS; pastikan klien dan tiket benar-benar milik workspace ini.
  const [client] = await db.select({ id: schema.workspaceClients.id }).from(schema.workspaceClients).where(eq(schema.workspaceClients.id, input.clientId)).limit(1);
  if (!client) throw new AppError("not_found", "Klien tidak ditemukan.");
  if (input.ticketId) {
    const [ticket] = await db.select({ id: schema.tickets.id }).from(schema.tickets).where(eq(schema.tickets.id, input.ticketId)).limit(1);
    if (!ticket) throw new AppError("not_found", "Tiket tidak ditemukan.");
  }
  const token = newToken(24);
  const booking = await insertBooking(db, { workspaceId: access.workspaceId, meetingTypeId: input.meetingTypeId, memberId, clientId: input.clientId, startsAt: input.startsAt, ticketId: input.ticketId, notes: input.notes, source: input.source ?? "staff", tokenHash: hashToken(token), now: input.now });
  await audit(db, { workspaceId: access.workspaceId, actorUserId, action: "booking.created", entityType: "booking", entityId: booking.id, diff: { memberId, startsAt: booking.startsAt.toISOString() } });
  return { id: booking.id, cancelToken: token, startsAt: booking.startsAt, endsAt: booking.endsAt, memberId, meetingType: booking.meetingType };
}

export async function cancelBooking(pool: pg.Pool, actor: Actor, bookingId: string) {
  return withWorkspace(pool, actor, "staff", (db, access) => cancelBookingIn(db, access, actor.userId, bookingId));
}

export async function cancelBookingIn(db: Db, access: WorkspaceAccess, actorUserId: string, bookingId: string) {
  const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId)).limit(1);
  if (!b) throw new AppError("not_found", "Booking tidak ditemukan.");
  await resolveMember(db, access, b.memberId);
  if (!["pending", "confirmed"].includes(b.status)) throw new AppError("invalid_input", "Booking ini sudah tidak aktif.");
  await db.update(schema.bookings).set({ status: "cancelled" }).where(and(eq(schema.bookings.id, bookingId), inArray(schema.bookings.status, ["pending", "confirmed"])));
  await audit(db, { workspaceId: access.workspaceId, actorUserId, action: "booking.cancelled", entityType: "booking", entityId: bookingId });
  await cancelBookingReminders(db, access.workspaceId, bookingId);
}

// --- Host jenis pertemuan ---------------------------------------------------------------------

/** Anggota yang melayani sebuah jenis pertemuan (slot publik = gabungan slot mereka). Admin ke atas. */
export async function setMeetingTypeHosts(pool: pg.Pool, actor: Actor, meetingTypeId: string, memberIds: string[]) {
  const unique = [...new Set(memberIds)];
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    const [mt] = await db.select({ id: schema.meetingTypes.id }).from(schema.meetingTypes).where(eq(schema.meetingTypes.id, meetingTypeId)).limit(1);
    if (!mt) throw new AppError("not_found", "Jenis pertemuan tidak ditemukan.");
    if (unique.length > 10) throw new AppError("invalid_input", "Maksimal 10 host per jenis pertemuan.");
    if (unique.length > 0) {
      const found = await db.select({ id: schema.workspaceMembers.id }).from(schema.workspaceMembers).where(inArray(schema.workspaceMembers.id, unique));
      if (found.length !== unique.length) throw new AppError("not_found", "Ada anggota yang tidak ditemukan.");
    }
    await db.delete(schema.meetingTypeHosts).where(eq(schema.meetingTypeHosts.meetingTypeId, meetingTypeId));
    if (unique.length > 0) await db.insert(schema.meetingTypeHosts).values(unique.map((memberId) => ({ workspaceId: access.workspaceId, meetingTypeId, memberId })));
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "meeting_type.hosts_set", entityType: "meeting_type", entityId: meetingTypeId, diff: { memberIds: unique } });
  });
}

export async function listMeetingTypeHosts(pool: pg.Pool, actor: Actor) {
  return withWorkspace(pool, actor, "staff", (db) =>
    db.select({ meetingTypeId: schema.meetingTypeHosts.meetingTypeId, memberId: schema.meetingTypeHosts.memberId }).from(schema.meetingTypeHosts),
  );
}

/** Batalkan pengingat email yang masih antre untuk sebuah booking (dibatalkan/dijadwal ulang). */
export async function cancelBookingReminders(db: Db, workspaceId: string, bookingId: string): Promise<void> {
  await asWorker(db, (w) =>
    w.execute(sql`UPDATE notification_outbox SET status = 'cancelled' WHERE dedupe_key LIKE ${`${workspaceId}:booking:${bookingId}:reminder:%`} AND status = 'queued'`),
  );
}
