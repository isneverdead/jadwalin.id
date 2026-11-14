import { adminOverview } from "@jadwalin/core";
import Link from "next/link";
import type { ReactNode } from "react";
import { getPool, requireSuperadmin, superadminEmails } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Superadmin · jadwalin.id", robots: { index: false, follow: false } };

/** Area superadmin platform: hanya akun berEmail terverifikasi di SUPERADMIN_EMAILS; selain itu 404. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const admin = await requireSuperadmin();
  const ov = await adminOverview(getPool(), admin.id, superadminEmails());
  return (
    <div className="wide">
      <header className="page-head">
        <div>
          <h1>Superadmin</h1>
          <p>Khusus pemilik platform. Semua tindakan di sini tercatat.</p>
        </div>
      </header>
      <nav className="chips" aria-label="Menu superadmin">
        <Link href="/admin">Ringkasan</Link>
        <Link href="/admin/pendaftar">Pendaftar baru</Link>
        <Link href="/admin/upgrade">Upgrade{ov.invoicesAwaiting > 0 ? ` (${ov.invoicesAwaiting})` : ""}</Link>
        <Link href="/admin/pengguna">Pengguna</Link>
      </nav>
      {children}
    </div>
  );
}
