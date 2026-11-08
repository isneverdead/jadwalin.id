import { AppError } from "@jadwalin/core";
import { schema, type Db } from "@jadwalin/db";
import { eq, sql } from "drizzle-orm";

export const TITLE_MIN = 3;
export const TITLE_MAX = 200;
export const BODY_MAX = 10_000;
/** Pembatas penyalahgunaan portal (klien terverifikasi, tapi tetap bisa menyepam). */
export const DAILY_TICKET_LIMIT = 10;
export const OPEN_TICKET_LIMIT = 25;

export type TicketRow = typeof schema.tickets.$inferSelect;
export type Priority = "low" | "normal" | "high" | "urgent";
export const PRIORITIES: readonly Priority[] = ["low", "normal", "high", "urgent"];

export function cleanTitle(value: string): string {
  const title = value.replace(/\s+/g, " ").trim();
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    throw new AppError("invalid_input", `Judul harus ${TITLE_MIN}–${TITLE_MAX} karakter.`);
  }
  return title;
}

export function cleanBody(value: string | undefined, label: string, required: boolean): string {
  const body = (value ?? "").trim();
  if (required && body.length === 0) throw new AppError("invalid_input", `${label} wajib diisi.`);
  if (body.length > BODY_MAX) throw new AppError("invalid_input", `${label} maksimal ${BODY_MAX} karakter.`);
  return body;
}

/** Nomor urut per workspace tanpa celah: baris penghitung dikunci selama transaksi, rollback ikut membatalkan nomor. */
export async function nextTicketNumber(db: Db, workspaceId: string): Promise<number> {
  const res = await db.execute<{ last_number: number }>(sql`
    INSERT INTO ticket_counters (workspace_id, last_number) VALUES (${workspaceId}, 1)
    ON CONFLICT (workspace_id) DO UPDATE SET last_number = ticket_counters.last_number + 1
    RETURNING last_number`);
  return res.rows[0]!.last_number;
}

export interface EventInput {
  workspaceId: string;
  ticketId: string;
  actorUserId: string | null;
  kind: "created" | "status" | "priority" | "assign" | "meeting" | "attachment";
  from?: string | null;
  to?: string | null;
  clientVisible?: boolean;
}

export async function recordEvent(db: Db, e: EventInput): Promise<void> {
  await db.insert(schema.ticketEvents).values({
    workspaceId: e.workspaceId,
    ticketId: e.ticketId,
    actorUserId: e.actorUserId,
    kind: e.kind,
    fromValue: e.from ?? null,
    toValue: e.to ?? null,
    clientVisible: e.clientVisible ?? true,
  });
}

export async function touchTicket(db: Db, ticketId: string, patch: Partial<Pick<TicketRow, "status" | "priority" | "assigneeMemberId" | "closedAt">> = {}): Promise<void> {
  await db.update(schema.tickets).set({ ...patch, updatedAt: new Date(), lastActivityAt: new Date() }).where(eq(schema.tickets.id, ticketId));
}

/** RLS sudah membatasi baris yang terlihat; tiket yang bukan haknya tampil sebagai tidak ditemukan. */
export async function findTicket(db: Db, number: number): Promise<TicketRow> {
  if (!Number.isInteger(number) || number < 1) throw new AppError("not_found", "Tiket tidak ditemukan.");
  const [t] = await db.select().from(schema.tickets).where(eq(schema.tickets.number, number)).limit(1);
  if (!t) throw new AppError("not_found", "Tiket tidak ditemukan.");
  return t;
}

export function assertOpen(ticket: TicketRow): void {
  if (ticket.status === "closed") throw new AppError("invalid_input", "Tiket ini sudah ditutup.");
}

export interface MeetingView {
  bookingId: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  title: string;
  locationKind: "link" | "phone" | "in_person";
  locationValue: string | null;
  /** Null bila pemanggil tidak berhak melihat anggota (klien). */
  memberName: string | null;
}

/** Waktu pertemuan sebenarnya (kolom starts_at/ends_at; `during` memuat buffer untuk anti-bentrok). */
export async function loadMeetings(db: Db, ticketId: string): Promise<MeetingView[]> {
  const res = await db.execute<{ booking_id: string; status: string; starts_at: Date; ends_at: Date; title: string; location_kind: MeetingView["locationKind"]; location_value: string | null; member_name: string | null }>(sql`
    SELECT b.id AS booking_id, b.status,
           b.starts_at, b.ends_at,
           mt.title, mt.location_kind, mt.location_value, u.name AS member_name
    FROM ticket_meetings tm
    JOIN bookings b ON b.id = tm.booking_id
    JOIN meeting_types mt ON mt.id = b.meeting_type_id
    LEFT JOIN workspace_members m ON m.id = b.member_id
    LEFT JOIN users u ON u.id = m.user_id
    WHERE tm.ticket_id = ${ticketId}
    ORDER BY starts_at`);
  return res.rows.map((r) => ({ bookingId: r.booking_id, status: r.status, startsAt: new Date(r.starts_at), endsAt: new Date(r.ends_at), title: r.title, locationKind: r.location_kind, locationValue: r.location_value, memberName: r.member_name }));
}

export function formatWhen(startsAt: Date, timezone: string): string {
  const label = timezone === "Asia/Makassar" ? "WITA" : timezone === "Asia/Jayapura" ? "WIT" : "WIB";
  const text = new Intl.DateTimeFormat("id-ID", { timeZone: timezone, dateStyle: "full", timeStyle: "short", hour12: false }).format(startsAt);
  return `${text} ${label}`;
}
