"use client";
import { useEffect, useState, type ReactNode } from "react";

/** Dasar layar formulir booking: menampilkan slot yang dipilih (dikirim SlotPicker) di atas tombol pesan yang menempel. */
export function BookCta({ children }: { children: ReactNode }) {
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => setPicked((e as CustomEvent<string | null>).detail);
    window.addEventListener("slot-picked", on);
    return () => window.removeEventListener("slot-picked", on);
  }, []);
  return (
    <div className="book-cta">
      <div className="book-cta-sel" aria-live="polite">{picked ? <><span>Pilihan Anda</span><b>{picked}</b></> : <span>Pilih tanggal dan jam dulu</span>}</div>
      {children}
    </div>
  );
}
