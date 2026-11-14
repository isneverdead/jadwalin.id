import { schema, type Db } from "@jadwalin/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { AppError, isExclusionViolation } from "./errors";
import { audit } from "./workspace";

/**
 * Sumber daya (barang/ruang/unit) yang dipesan per RENTANG waktu. Ini bagian dari penjadwalan inti: modul (mis. sewa)
 * tidak membuat kalendernya sendiri, tetapi memakai primitif ini. Anti-bentrok ditegakkan database (constraint
 * `reservations_no_overlap`); kode di sini hanya memilih unit bebas dan menerjemahkan galat.
 */
export const HOLDING_STATUSES = ["pending", "confirmed", "active"] as const;
export type ReservationStatus = (typeof HOLDING_STATUSES)[number] | "completed" | "cancelled" | "rejected";

export const MAX_RESERVATION_DAYS = 90;
const DAY_MS = 24 * 3600_000;

export async function createResourceInTx(db: Db, workspaceId: string, input: { name: string; units: number }): Promise<string> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw new AppError("invalid_input", "Nama 2–80 karakter.");
  if (!Number.isInteger(input.units) || input.units < 1 || input.units > 50) throw new AppError("invalid_input", "Jumlah unit 1–50.");
  const id = randomUUID();
  await db.insert(schema.resources).values({ id, workspaceId, name, units: input.units });
  return id;
}

export async function updateResourceInTx(db: Db, resourceId: string, patch: { name?: string; units?: number; active?: boolean }): Promise<void> {
  const set: Partial<typeof schema.resources.$inferInsert> = {};
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (n.length < 2 || n.length > 80) throw new AppError("invalid_input", "Nama 2–80 karakter.");
    set.name = n;
  }
  if (patch.units !== undefined) {
    if (!Number.isInteger(patch.units) || patch.units < 1 || patch.units > 50) throw new AppError("invalid_input", "Jumlah unit 1–50.");
    // Mengurangi unit tidak boleh memutus pemesanan yang masih menahan unit bernomor lebih besar.
    const [held] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.reservations)
      .where(and(eq(schema.reservations.resourceId, resourceId), inArray(schema.reservations.status, [...HOLDING_STATUSES]), sql`${schema.reservations.unitNo} > ${patch.units}`));
    if ((held?.n ?? 0) > 0) throw new AppError("invalid_input", "Jumlah unit tidak bisa dikurangi: masih ada pesanan aktif yang memakai unit itu.");
    set.units = patch.units;
  }
  if (patch.active !== undefined) set.active = patch.active;
  if (Object.keys(set).length === 0) return;
  const r = await db.update(schema.resources).set(set).where(eq(schema.resources.id, resourceId)).returning({ id: schema.resources.id });
  if (r.length === 0) throw new AppError("not_found", "Sumber daya tidak ditemukan.");
}

export interface ResourceBusyRange { unitNo: number; start: Date; end: Date }

/** Rentang yang menahan unit dan bersinggungan dengan [from, to). */
export async function listResourceBusyRanges(db: Db, resourceId: string, from: Date, to: Date): Promise<ResourceBusyRange[]> {
  const rows = await db
    .select({ unitNo: schema.reservations.unitNo, start: sql<Date>`lower(${schema.reservations.during})`, end: sql<Date>`upper(${schema.reservations.during})` })
    .from(schema.reservations)
    .where(and(eq(schema.reservations.resourceId, resourceId), inArray(schema.reservations.status, [...HOLDING_STATUSES]), sql`${schema.reservations.during} && tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, '[)')`));
  return rows.map((r) => ({ unitNo: r.unitNo, start: new Date(r.start), end: new Date(r.end) }));
}

/**
 * Murni: untuk tiap jendela hari, apakah masih ada minimal satu unit bebas PENUH di sepanjang jendela itu.
 * (Pesanan menahan unit selama rentangnya; hari yang sebagian saja tersita dianggap tidak tersedia.)
 */
export function freeDays(units: number, busy: readonly ResourceBusyRange[], days: readonly { start: Date; end: Date }[]): boolean[] {
  return days.map((d) => {
    const taken = new Set(busy.filter((b) => b.start < d.end && b.end > d.start).map((b) => b.unitNo));
    return taken.size < units;
  });
}

export interface ReserveInput { workspaceId: string; resourceId: string; clientId: string; startsAt: Date; endsAt: Date; tokenHash: string; notes?: string | null }

/** Memilih unit bebas terkecil lalu menyimpan reservasi 'pending'. Bentrok serentak ditolak constraint → slot_unavailable. */
export async function reserveUnit(db: Db, input: ReserveInput): Promise<{ id: string; unitNo: number }> {
  if (!(input.endsAt > input.startsAt)) throw new AppError("invalid_input", "Rentang waktu tidak valid.");
  if (input.endsAt.getTime() - input.startsAt.getTime() > MAX_RESERVATION_DAYS * DAY_MS) throw new AppError("invalid_input", `Maksimal ${MAX_RESERVATION_DAYS} hari per pesanan.`);
  const [res] = await db.select({ units: schema.resources.units, active: schema.resources.active }).from(schema.resources).where(eq(schema.resources.id, input.resourceId)).limit(1);
  if (!res || !res.active) throw new AppError("not_found", "Barang tidak ditemukan.");
  const busy = await listResourceBusyRanges(db, input.resourceId, input.startsAt, input.endsAt);
  const taken = new Set(busy.map((b) => b.unitNo));
  let unitNo = 0;
  for (let u = 1; u <= res.units; u++) if (!taken.has(u)) { unitNo = u; break; }
  if (unitNo === 0) throw new AppError("slot_unavailable", "Tanggal itu sudah tidak tersedia. Pilih tanggal lain.");
  const id = randomUUID();
  try {
    await db.insert(schema.reservations).values({
      id,
      workspaceId: input.workspaceId,
      resourceId: input.resourceId,
      unitNo,
      clientId: input.clientId,
      during: `[${input.startsAt.toISOString()},${input.endsAt.toISOString()})`,
      status: "pending",
      tokenHash: input.tokenHash,
      notes: input.notes?.trim() || null,
    });
  } catch (error) {
    if (isExclusionViolation(error, "reservations_no_overlap")) throw new AppError("slot_unavailable", "Tanggal itu baru saja dipesan orang lain. Pilih tanggal lain.");
    throw error;
  }
  return { id, unitNo };
}

/** Transisi status yang diizinkan (staf). Pembatalan oleh tamu memakai token dan hanya menuju 'cancelled'. */
const NEXT: Record<string, readonly ReservationStatus[]> = {
  pending: ["confirmed", "rejected", "cancelled"],
  confirmed: ["active", "cancelled"],
  active: ["completed"],
};
export function canMoveReservation(from: string, to: ReservationStatus): boolean {
  return (NEXT[from] ?? []).includes(to);
}

export async function setReservationStatusInTx(db: Db, access: { workspaceId: string }, actorUserId: string, reservationId: string, to: ReservationStatus): Promise<{ from: string }> {
  const [r] = await db.select({ status: schema.reservations.status }).from(schema.reservations).where(eq(schema.reservations.id, reservationId)).limit(1);
  if (!r) throw new AppError("not_found", "Pesanan tidak ditemukan.");
  if (!canMoveReservation(r.status, to)) throw new AppError("invalid_input", "Status pesanan tidak bisa diubah ke itu dari keadaan sekarang.");
  await db.update(schema.reservations).set({ status: to }).where(eq(schema.reservations.id, reservationId));
  await audit(db, { workspaceId: access.workspaceId, actorUserId, action: `reservation.${to}`, entityType: "reservation", entityId: reservationId, diff: { from: r.status } });
  return { from: r.status };
}
