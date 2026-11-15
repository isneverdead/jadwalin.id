"use client";
import { useEffect, useMemo, useState } from "react";

export interface PickerDay {
  /** Tanggal lokal workspace "YYYY-MM-DD". */
  date: string;
  times: { iso: string; label: string }[];
}

const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const WEEKDAYS = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

const monthOf = (date: string) => date.slice(0, 7);
const fmtLong = (date: string) => new Intl.DateTimeFormat("id-ID", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T12:00:00Z`));
const fmtShort = (date: string) => new Intl.DateTimeFormat("id-ID", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${date}T12:00:00Z`));

/**
 * Pemilih jadwal bergaya kalender: bulan → tanggal (hanya yang punya slot yang bisa diklik) → jam.
 * Nilai terpilih dikirim lewat input tersembunyi `name` (ISO UTC), sehingga form server action tidak berubah.
 */
export function SlotPicker({ days, todayKey, tzName, name = "startsAt" }: { days: PickerDay[]; todayKey: string; tzName: string; name?: string }) {
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d.times])), [days]);
  const months = useMemo(() => [...new Set(days.map((d) => monthOf(d.date)))].sort(), [days]);
  const [month, setMonth] = useState(months[0] ?? monthOf(todayKey));
  const [date, setDate] = useState<string | null>(days[0]?.date ?? null);
  const [iso, setIso] = useState("");

  const [y, m] = month.split("-").map(Number) as [number, number];
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Senin = 0
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [...Array<null>(lead).fill(null), ...Array.from({ length: total }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  const idx = months.indexOf(month);
  const times = date ? byDate.get(date) ?? [] : [];
  const chosen = times.find((t) => t.iso === iso);
  // Kabari tombol pesan yang menempel di dasar layar (BookCta) tentang slot yang sedang dipilih.
  const summary = chosen && date ? `${new Intl.DateTimeFormat("id-ID", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00Z`))} · ${chosen.label} ${tzName}` : null;
  useEffect(() => { window.dispatchEvent(new CustomEvent("slot-picked", { detail: summary })); }, [summary]);

  return (
    <div className="picker" data-slots={days.flatMap((d) => d.times.map((t) => t.iso)).join(",")}>
      <div className="cal" role="group" aria-label={`Kalender ${MONTHS[m - 1]} ${y}`}>
        <div className="cal-head">
          <button type="button" className="cal-nav" aria-label="Bulan sebelumnya" disabled={idx <= 0} onClick={() => setMonth(months[idx - 1]!)}>‹</button>
          <strong aria-live="polite">{MONTHS[m - 1]} {y}</strong>
          <button type="button" className="cal-nav" aria-label="Bulan berikutnya" disabled={idx < 0 || idx >= months.length - 1} onClick={() => setMonth(months[idx + 1]!)}>›</button>
        </div>
        <div className="cal-grid">
          {WEEKDAYS.map((w) => <span key={w} className="cal-dow">{w}</span>)}
          {cells.map((c, i) => {
            if (!c) return <span key={`b${i}`} />;
            const n = byDate.get(c)?.length ?? 0;
            const cls = ["cal-day", n > 0 ? "has" : "", c === date ? "sel" : "", c === todayKey ? "today" : ""].join(" ");
            return (
              <button key={c} type="button" className={cls} disabled={n === 0} aria-pressed={c === date} aria-label={n > 0 ? `${fmtShort(c)}, ${n} jam tersedia` : `${fmtShort(c)}, tidak tersedia`} onClick={() => { setDate(c); setIso(""); }}>
                {Number(c.slice(8))}
              </button>
            );
          })}
        </div>
        {days.length === 0 && <p className="cal-empty">Belum ada jadwal kosong.</p>}
      </div>

      {date && (
        <div className="times">
          <p className="times-title">{fmtShort(date)} <small>· jam dalam {tzName}</small></p>
          <div className="time-grid" role="radiogroup" aria-label={`Jam tersedia ${fmtShort(date)}`}>
            {times.map((t) => (
              <button key={t.iso} type="button" role="radio" aria-checked={t.iso === iso} className={`chip${t.iso === iso ? " on" : ""}`} onClick={() => setIso(t.iso)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="picked" aria-live="polite">
        {chosen && date ? <>✓ {fmtLong(date)} · <strong>{chosen.label} {tzName}</strong></> : <span>Pilih tanggal, lalu jam.</span>}
      </div>
      {/* Wajib terisi agar form tidak terkirim tanpa waktu; disembunyikan secara visual tetapi tetap tervalidasi browser. */}
      <input className="vh-input" name={name} value={iso} onChange={() => undefined} required tabIndex={-1} aria-hidden="true" />
    </div>
  );
}
