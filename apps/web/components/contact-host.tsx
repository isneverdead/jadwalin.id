"use client";
import { useEffect, useState } from "react";

/**
 * Tombol samar "Hubungi langsung": membuka WhatsApp penyedia jasa dengan konteks yang sudah dilakukan pelanggan
 * (status booking, pembayaran, pengajuan) dan tautan booking-nya. Pelanggan yang menekan Kirim (wa.me, bukan API).
 */
export function ContactHost({ phone, ws, lines, token }: { phone: string; ws: string; lines: string[]; token: string }) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    const url = `${window.location.origin}/booking/${token}`;
    const text = [`Halo ${ws},`, ...lines, "", `Tautan booking saya: ${url}`, "", "Yang ingin saya tanyakan: "].join("\n");
    setHref(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`);
  }, [phone, ws, lines, token]);
  if (!href) return null;
  return (
    <p className="contact-host">
      <a href={href} target="_blank" rel="noopener">Butuh bantuan? Hubungi {ws} langsung</a>
    </p>
  );
}
