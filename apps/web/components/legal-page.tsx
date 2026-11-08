import { LEGAL_VERSION } from "@jadwalin/core";
import Link from "next/link";
import type { ReactNode } from "react";

export const LEGAL_LINKS = [
  ["/syarat", "Syarat Layanan"],
  ["/privasi", "Kebijakan Privasi"],
  ["/refund", "Kebijakan Refund"],
  ["/dpa", "Perjanjian Pemrosesan Data"],
  ["/penggunaan-wajar", "Penggunaan Wajar"],
  ["/tentang", "Identitas Usaha"],
] as const;

/** Kerangka halaman legal. Isi masih DRAF: wajib ditinjau penasihat hukum sebelum launch (lihat docs/security-checklist.md). */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article>
      <p><Link href="/">← Beranda</Link></p>
      <h1>{title}</h1>
      <p><small>Versi {LEGAL_VERSION} · DRAF, belum ditinjau penasihat hukum. Isi dapat berubah sebelum peluncuran resmi.</small></p>
      {children}
      <hr />
      <p><small>{LEGAL_LINKS.map(([href, label], i) => (<span key={href}>{i > 0 && " · "}<Link href={href}>{label}</Link></span>))}</small></p>
    </article>
  );
}
