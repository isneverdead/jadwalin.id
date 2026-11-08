/**
 * Mesin slot MURNI (tanpa DB, tanpa jam sistem): semua masukan eksplisit supaya bisa diuji properti.
 * Zona waktu workspace dibatasi ke tiga zona Indonesia yang tanpa DST, sehingga offset tetap
 * dan perhitungan tidak butuh pustaka zona waktu.
 */
const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

export const TIMEZONE_OFFSET_MIN = {
  "Asia/Jakarta": 7 * 60, // WIB
  "Asia/Makassar": 8 * 60, // WITA
  "Asia/Jayapura": 9 * 60, // WIT
} as const;
export type WorkspaceTimezone = keyof typeof TIMEZONE_OFFSET_MIN;

export function isWorkspaceTimezone(value: string): value is WorkspaceTimezone {
  return Object.prototype.hasOwnProperty.call(TIMEZONE_OFFSET_MIN, value);
}

/** Jam rutin mingguan. weekday: 0 = Minggu … 6 = Sabtu. Jam lokal "HH:MM" (atau "HH:MM:SS" dari Postgres). */
export interface WeeklyRule {
  weekday: number;
  start: string;
  end: string;
}

/** Pengecualian per tanggal lokal "YYYY-MM-DD". blocked tanpa jam = libur seharian. */
export interface DateOverride {
  date: string;
  kind: "blocked" | "extra";
  start?: string | null;
  end?: string | null;
}

export interface BusyRange {
  start: Date;
  end: Date;
}

export interface SlotInput {
  now: Date;
  timezone: WorkspaceTimezone;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxDaysAhead: number;
  stepMin: number;
  rules: readonly WeeklyRule[];
  overrides: readonly DateOverride[];
  /** Booking aktif milik anggota yang sama; `during`-nya sudah termasuk buffer masing-masing. */
  busy: readonly BusyRange[];
}

export interface Slot {
  start: Date;
  end: Date;
}

type Interval = [number, number];

export function parseHM(value: string): number {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!m) throw new Error(`Jam tidak valid: ${value}`);
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[1]) > 24 || Number(m[2]) > 59 || minutes > 24 * 60) throw new Error(`Jam tidak valid: ${value}`);
  return minutes;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Tanggal lokal "YYYY-MM-DD" dari instan UTC. */
export function localDateOf(instantMs: number, offsetMin: number): string {
  const d = new Date(instantMs + offsetMin * MS_MIN);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function dateMs(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Tanggal tidak valid: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function addDays(date: string, days: number): string {
  const d = new Date(dateMs(date) + days * MS_DAY);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function weekdayOf(date: string): number {
  return new Date(dateMs(date)).getUTCDay();
}

/** Instan UTC (ms) untuk jam lokal `minutes` (menit sejak 00:00) pada tanggal lokal `date`. */
export function localToUtcMs(date: string, minutes: number, offsetMin: number): number {
  return dateMs(date) + minutes * MS_MIN - offsetMin * MS_MIN;
}

function merge(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function subtract(windows: Interval[], [bs, be]: Interval): Interval[] {
  const out: Interval[] = [];
  for (const [s, e] of windows) {
    if (be <= s || bs >= e) out.push([s, e]);
    else {
      if (bs > s) out.push([s, bs]);
      if (be < e) out.push([be, e]);
    }
  }
  return out;
}

/** Jendela tersedia (menit lokal) untuk satu tanggal: jam rutin + jam tambahan − blokir. */
export function windowsForDate(date: string, rules: readonly WeeklyRule[], overrides: readonly DateOverride[]): Interval[] {
  const weekday = weekdayOf(date);
  let windows: Interval[] = rules.filter((r) => r.weekday === weekday).map((r) => [parseHM(r.start), parseHM(r.end)]);
  const todays = overrides.filter((o) => o.date === date);
  for (const o of todays) {
    if (o.kind === "extra" && o.start && o.end) windows.push([parseHM(o.start), parseHM(o.end)]);
  }
  windows = merge(windows);
  for (const o of todays) {
    if (o.kind !== "blocked") continue;
    if (!o.start || !o.end) return [];
    windows = subtract(windows, [parseHM(o.start), parseHM(o.end)]);
  }
  return merge(windows);
}

/** Batas keamanan: jumlah slot per perhitungan (mencegah konfigurasi ekstrem menjadi beban CPU pada halaman publik). */
export const MAX_SLOTS_PER_QUERY = 3000;

export function computeSlots(input: SlotInput): Slot[] {
  const { now, timezone, durationMin, bufferBeforeMin, bufferAfterMin, minNoticeMin, maxDaysAhead, stepMin } = input;
  if (!(durationMin > 0) || !(stepMin > 0)) throw new Error("durationMin dan stepMin harus positif");
  const offset = TIMEZONE_OFFSET_MIN[timezone];
  const earliest = now.getTime() + minNoticeMin * MS_MIN;
  const latest = now.getTime() + maxDaysAhead * MS_DAY;

  const slots: Slot[] = [];
  const lastDate = localDateOf(latest, offset);
  for (let date = localDateOf(now.getTime(), offset); date <= lastDate; date = addDays(date, 1)) {
    for (const [ws, we] of windowsForDate(date, input.rules, input.overrides)) {
      for (let s = ws; s + durationMin <= we; s += stepMin) {
        const start = localToUtcMs(date, s, offset);
        if (start < earliest || start > latest) continue;
        const end = start + durationMin * MS_MIN;
        const lo = start - bufferBeforeMin * MS_MIN;
        const hi = end + bufferAfterMin * MS_MIN;
        if (input.busy.some((b) => b.start.getTime() < hi && b.end.getTime() > lo)) continue;
        slots.push({ start: new Date(start), end: new Date(end) });
        if (slots.length >= MAX_SLOTS_PER_QUERY) return slots;
      }
    }
  }
  return slots;
}
