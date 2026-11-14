export interface IcsEvent {
  uid: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  description?: string;
  location?: string;
  url?: string;
  /** Waktu pembuatan; ditentukan pemanggil agar fungsi ini murni dan mudah diuji. */
  now: Date;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/;/g, "\;").replace(/,/g, "\\,");

/** Lipat baris >75 oktet sesuai RFC 5545 (lanjutan diawali satu spasi). */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    if (curBytes + n > (parts.length === 0 ? 75 : 74)) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

/** Berkas .ics satu acara (waktu UTC), untuk "Tambah ke kalender". */
export function buildIcs(e: IcsEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//jadwalin.id//booking//ID",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.uid}@jadwalin.id`,
    `DTSTAMP:${stamp(e.now)}`,
    `DTSTART:${stamp(e.startsAt)}`,
    `DTEND:${stamp(e.endsAt)}`,
    `SUMMARY:${esc(e.title)}`,
    ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
    ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
    ...(e.url ? [`URL:${e.url}`] : []),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Pengingat jadwal",
    "TRIGGER:-PT1H",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Tautan "Tambah ke Google Kalender". */
export function googleCalendarUrl(e: Pick<IcsEvent, "title" | "startsAt" | "endsAt" | "description" | "location">): string {
  const p = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates: `${stamp(e.startsAt)}/${stamp(e.endsAt)}` });
  if (e.description) p.set("details", e.description);
  if (e.location) p.set("location", e.location);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}
