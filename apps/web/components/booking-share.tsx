"use client";
import { useEffect, useState } from "react";

const KEY = "jd-bookings";
export interface SavedBooking { token: string; code: string; title: string; ws: string; slug: string; when: string; savedAt: number }

export function readSaved(): SavedBooking[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as SavedBooking[];
    return Array.isArray(raw) ? raw.filter((b) => b && typeof b.token === "string" && typeof b.code === "string") : [];
  } catch {
    return [];
  }
}
export function writeSaved(list: SavedBooking[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20))); } catch { /* penyimpanan bisa diblokir */ }
}

/**
 * Menjaga pelanggan tidak kehilangan booking (tanpa email): menyimpan tautan di perangkat ("Booking saya"),
 * tombol salin, dan kirim-ke-WhatsApp lewat tautan wa.me biasa (pelanggan menekan Kirim sendiri; bukan API).
 */
export function BookingShare({ token, code, title, ws, slug, when }: { token: string; code: string; title: string; ws: string; slug: string; when: string }) {
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const link = `${window.location.origin}/booking/${token}`;
    setUrl(link);
    const rest = readSaved().filter((b) => b.code !== code);
    writeSaved([{ token, code, title, ws, slug, when, savedAt: Date.now() }, ...rest]);
  }, [token, code, title, ws, slug, when]);

  const text = `Booking ${title} di ${ws}\n${when}\nKode: ${code}\nKelola booking: ${url}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* abaikan */ }
  }
  return (
    <section className="panel tight keep-link" aria-labelledby="keep-h">
      <h3 id="keep-h">Simpan tautan booking ini</h3>
      <p>Tautan ini adalah “kunci” booking Anda. Simpan supaya bisa dibuka lagi untuk mengubah, membatalkan, atau melihat status.</p>
      <div className="row-btns">
        <a className="btn" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener">Kirim ke WhatsApp saya</a>
        <button type="button" className="btn-ghost" onClick={copy}>{copied ? "Tautan tersalin ✓" : "Salin tautan"}</button>
      </div>
      <small>Tersimpan juga di perangkat ini: <a href="/booking/saya">Booking saya</a>. Hilang tautan? <a href={`/booking/cari?u=${encodeURIComponent(slug)}&kode=${encodeURIComponent(code)}`}>Pulihkan dengan kode booking dan nomor HP</a>.</small>
    </section>
  );
}
