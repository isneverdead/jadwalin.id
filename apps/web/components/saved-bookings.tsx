"use client";
import { useEffect, useState } from "react";
import { readSaved, writeSaved, type SavedBooking } from "./booking-share";

/** Daftar booking yang tersimpan di perangkat ini (tanpa server). */
export function SavedBookings() {
  const [list, setList] = useState<SavedBooking[] | null>(null);
  useEffect(() => { setList(readSaved()); }, []);
  if (list === null) return <p>Memuat…</p>;
  if (list.length === 0) {
    return <div className="empty"><strong>Belum ada booking tersimpan di perangkat ini.</strong><small>Booking yang Anda buka lewat tautan akan muncul di sini. Atau <a href="/booking/cari">pulihkan dengan kode booking dan nomor HP</a>.</small></div>;
  }
  const remove = (code: string) => { const next = list.filter((b) => b.code !== code); writeSaved(next); setList(next); };
  return (
    <div className="list">
      {list.map((b) => (
        <div className="list-row" key={b.code}>
          <div className="grow"><strong>{b.title}</strong><small>{b.ws} · {b.when}</small><small>Kode {b.code}</small></div>
          <a className="btn btn-sm" href={`/booking/${b.token}`}>Buka</a>
          <button type="button" className="link danger-link" onClick={() => remove(b.code)}>Hapus dari daftar</button>
        </div>
      ))}
    </div>
  );
}
