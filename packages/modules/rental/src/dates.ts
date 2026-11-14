import { AppError, TIMEZONE_OFFSET_MIN, isWorkspaceTimezone, localDateOf, MAX_RESERVATION_DAYS } from "@jadwalin/core";

const DAY_MS = 24 * 3600_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Murni: semua masukan eksplisit (tanpa jam sistem/DB) supaya bisa diuji. */
export function parseDate(value: string): { y: number; m: number; d: number } {
  const m = DATE_RE.exec(value);
  if (!m) throw new AppError("invalid_input", "Tanggal tidak valid.");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) throw new AppError("invalid_input", "Tanggal tidak valid.");
  return { y, m: mo, d };
}

export function offsetOf(timezone: string): number {
  if (!isWorkspaceTimezone(timezone)) throw new AppError("invalid_input", "Zona waktu tidak didukung.");
  return TIMEZONE_OFFSET_MIN[timezone];
}

/** Awal hari (00:00) tanggal itu di zona usaha, sebagai instan UTC. Zona WIB/WITA/WIT tanpa DST. */
export function localMidnight(date: string, timezone: string): Date {
  const { y, m, d } = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d) - offsetOf(timezone) * 60_000);
}

export function addDays(date: string, n: number): string {
  const { y, m, d } = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetweenInclusive(start: string, end: string): number {
  const a = parseDate(start);
  const b = parseDate(end);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS) + 1;
}

export function todayLocal(now: Date, timezone: string): string {
  return localDateOf(now.getTime(), offsetOf(timezone));
}

/**
 * Jendela sewa: hari pertama dan terakhir (keduanya termasuk) → [00:00 hari pertama, 00:00 hari setelah hari terakhir).
 * Tanggal ambil tidak boleh di masa lalu (menurut zona usaha).
 */
export function rentalWindow(startDate: string, endDate: string, timezone: string, now: Date): { startsAt: Date; endsAt: Date; days: number } {
  const days = daysBetweenInclusive(startDate, endDate);
  if (days < 1) throw new AppError("invalid_input", "Tanggal kembali harus sama dengan atau setelah tanggal ambil.");
  if (days > MAX_RESERVATION_DAYS) throw new AppError("invalid_input", `Maksimal ${MAX_RESERVATION_DAYS} hari sekali sewa.`);
  if (startDate < todayLocal(now, timezone)) throw new AppError("invalid_input", "Tanggal ambil tidak boleh di masa lalu.");
  return { startsAt: localMidnight(startDate, timezone), endsAt: localMidnight(addDays(endDate, 1), timezone), days };
}

/** Jendela per hari untuk `count` hari mulai `fromDate`. */
export function dayWindows(fromDate: string, count: number, timezone: string): { date: string; start: Date; end: Date }[] {
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(fromDate, i);
    return { date, start: localMidnight(date, timezone), end: localMidnight(addDays(date, 1), timezone) };
  });
}
