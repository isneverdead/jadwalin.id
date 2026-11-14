import type { WorkspaceTimezone } from "@jadwalin/core";

export const STATUS_LABEL: Record<string, string> = {
  open: "Terbuka",
  in_progress: "Diproses",
  waiting_client: "Menunggu klien",
  resolved: "Selesai",
  closed: "Ditutup",
};

export const PRIORITY_LABEL: Record<string, string> = { low: "Rendah", normal: "Normal", high: "Tinggi", urgent: "Mendesak" };

const TZ_LABEL: Record<string, string> = { "Asia/Jakarta": "WIB", "Asia/Makassar": "WITA", "Asia/Jayapura": "WIT" };

export function tzLabel(tz: string): string {
  return TZ_LABEL[tz] ?? tz;
}

export function fmtDateTime(date: Date, tz: string): string {
  return `${new Intl.DateTimeFormat("id-ID", { timeZone: tz as WorkspaceTimezone, dateStyle: "medium", timeStyle: "short", hour12: false }).format(date)} ${tzLabel(tz)}`;
}

export function fmtDay(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("id-ID", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(date);
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Teks riwayat; `actor` sudah diputuskan pemanggil ("Anda", "Tim", atau nama staf). */
export function describeEvent(e: { kind: string; from: string | null; to: string | null }, actor: string): string {
  switch (e.kind) {
    case "created": return `${actor} membuat tiket`;
    case "status": return `${actor} mengubah status: ${STATUS_LABEL[e.from ?? ""] ?? e.from} → ${STATUS_LABEL[e.to ?? ""] ?? e.to}`;
    case "priority": return `${actor} mengubah prioritas: ${PRIORITY_LABEL[e.from ?? ""] ?? e.from} → ${PRIORITY_LABEL[e.to ?? ""] ?? e.to}`;
    case "assign": return `${actor} mengubah penanggung jawab`;
    case "attachment": return `${actor} melampirkan berkas “${e.to}”`;
    case "meeting": return e.to === "dibatalkan" ? `${actor} membatalkan meeting` : `${actor} menjadwalkan meeting`;
    default: return `${actor} memperbarui tiket`;
  }
}

/** Kelompokkan slot per hari lokal workspace untuk ditampilkan (optgroup). */
export function groupSlotsByDay(slots: { start: Date }[], tz: string): { day: string; items: { iso: string; label: string }[] }[] {
  const timeFmt = new Intl.DateTimeFormat("id-ID", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const groups = new Map<string, { iso: string; label: string }[]>();
  for (const s of slots) {
    const day = fmtDay(s.start, tz);
    groups.set(day, [...(groups.get(day) ?? []), { iso: s.start.toISOString(), label: `${timeFmt.format(s.start).replace(".", ":")} ${tzLabel(tz)}` }]);
  }
  return [...groups.entries()].map(([day, items]) => ({ day, items }));
}

/** Slot → hari-hari untuk SlotPicker: kunci tanggal lokal workspace + jam "HH:MM". */
export function toPickerDays(slots: { start: Date }[], tz: string): { days: { date: string; times: { iso: string; label: string }[] }[]; todayKey: string } {
  const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const timeFmt = new Intl.DateTimeFormat("id-ID", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const map = new Map<string, { iso: string; label: string }[]>();
  for (const s of slots) {
    const key = dateFmt.format(s.start);
    map.set(key, [...(map.get(key) ?? []), { iso: s.start.toISOString(), label: timeFmt.format(s.start).replace(".", ":") }]);
  }
  return { days: [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, times]) => ({ date, times })), todayKey: dateFmt.format(new Date()) };
}

export function fmtIdr(n: number): string {
  return `Rp${n.toLocaleString("id-ID")}`;
}
