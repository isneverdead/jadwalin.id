import { createHash } from "node:crypto";

// Tanpa 0/O/1/I/L supaya mudah dibaca dan disebutkan lewat telepon/WhatsApp.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/**
 * Kode booking pendek untuk dibaca manusia ("JDW-7K3M9Q"), diturunkan dari id booking (tanpa kolom baru,
 * berlaku juga untuk booking lama). Hanya rujukan tampilan: bukan rahasia dan bukan kunci akses.
 */
export function bookingCode(bookingId: string): string {
  const h = createHash("sha256").update(`jdw:${bookingId}`).digest();
  let out = "";
  for (let i = 0; i < 6; i++) out += ALPHABET[h[i]! % ALPHABET.length];
  return `JDW-${out}`;
}
