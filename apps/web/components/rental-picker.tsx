"use client";
import { useMemo, useState } from "react";

export interface DayAvail { date: string; available: boolean }

const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const DOW = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];
const idr = (n: number) => `Rp${n.toLocaleString("id-ID")}`;
const fmtDate = (d: string) => { const [y, m, day] = d.split("-").map(Number); return `${day} ${MONTHS[m! - 1]!.slice(0, 3)} ${y}`; };

/** Kalender pilih rentang tanggal sewa (hari pertama dan terakhir, keduanya termasuk). Menulis `startDate`/`endDate` ke form. */
export function RentalPicker({ days, pricePerDayIdr }: { days: DayAvail[]; pricePerDayIdr: number }) {
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d.available])), [days]);
  const first = days[0]?.date ?? "";
  const [view, setView] = useState(() => first.slice(0, 7));
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const [vy, vm] = view.split("-").map(Number) as [number, number];
  const monthDays = new Date(Date.UTC(vy, vm, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(vy, vm - 1, 1)).getUTCDay() + 6) % 7; // Senin = 0
  const lastDate = days[days.length - 1]?.date ?? "";
  const canPrev = view > first.slice(0, 7);
  const canNext = view < lastDate.slice(0, 7);
  const shift = (n: number) => { const t = new Date(Date.UTC(vy, vm - 1 + n, 1)); setView(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`); };

  const allFree = (a: string, b: string) => { for (const [d, ok] of byDate) if (d >= a && d <= b && !ok) return false; return days.some((x) => x.date === b); };
  function pick(d: string) {
    if (!byDate.get(d)) return;
    if (!start || end) { setStart(d); setEnd(""); return; }
    if (d < start) { setStart(d); return; }
    if (allFree(start, d)) setEnd(d); else { setStart(d); setEnd(""); }
  }
  const n = start && (end || start) ? Math.round((Date.parse(end || start) - Date.parse(start)) / 86400000) + 1 : 0;
  const inRange = (d: string) => start && d >= start && d <= (end || start);

  return (
    <div className="rp">
      <input type="hidden" name="startDate" value={start} required />
      <input type="hidden" name="endDate" value={end || start} required />
      <div className="cal" role="group" aria-label="Pilih tanggal sewa">
        <div className="cal-head">
          <button type="button" className="cal-nav" onClick={() => shift(-1)} disabled={!canPrev} aria-label="Bulan sebelumnya">‹</button>
          <strong>{MONTHS[vm - 1]} {vy}</strong>
          <button type="button" className="cal-nav" onClick={() => shift(1)} disabled={!canNext} aria-label="Bulan berikutnya">›</button>
        </div>
        <div className="cal-grid">
          {DOW.map((d) => <span className="cal-dow" key={d}>{d}</span>)}
          {Array.from({ length: lead }, (_, i) => <span key={`l${i}`} />)}
          {Array.from({ length: monthDays }, (_, i) => {
            const d = `${view}-${String(i + 1).padStart(2, "0")}`;
            const ok = byDate.get(d) === true;
            const known = byDate.has(d);
            return (
              <button type="button" key={d} disabled={!ok} onClick={() => pick(d)} aria-pressed={Boolean(inRange(d))} aria-label={`${i + 1} ${MONTHS[vm - 1]}${known ? (ok ? ", tersedia" : ", tidak tersedia") : ""}`}
                className={`cal-day${ok ? " has" : ""}${inRange(d) ? " sel" : ""}${d === start ? " rp-start" : ""}${d === (end || start) && start ? " rp-end" : ""}`}>
                {i + 1}
              </button>
            );
          })}
        </div>
      </div>
      <div className="rp-sum" aria-live="polite">
        {!start && <small>Klik tanggal ambil, lalu tanggal kembali (hari terakhir sewa).</small>}
        {start && !end && <small>Tanggal ambil: <b>{fmtDate(start)}</b>. Klik tanggal kembali, atau biarkan untuk sewa 1 hari.</small>}
        {start && (
          <div className="rp-total">
            <span>{fmtDate(start)}{end && end !== start ? ` – ${fmtDate(end)}` : ""} · {n} hari</span>
            <strong>{idr(n * pricePerDayIdr)}</strong>
          </div>
        )}
      </div>
    </div>
  );
}
