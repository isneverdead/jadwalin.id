import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Suspense, type ReactNode } from "react";
import { Figtree, Geist_Mono } from "next/font/google";
import "./globals.css";
import { NavProgress } from "@/components/nav-progress";
import { currentUser, userIsSuperadmin } from "@/lib/server";
import { LogoutButton } from "./logout-button";

const figtree = Figtree({ subsets: ["latin"], variable: "--f-figtree", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--f-geist-mono", display: "swap" });

// CSP ber-nonce butuh render dinamis per permintaan (lihat middleware.ts).
export const dynamic = "force-dynamic";

// viewport-fit=cover: konten boleh sampai tepi layar, area aman diatur lewat env(safe-area-inset-*).
export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f1" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1013" },
  ],
};

export const metadata: Metadata = {
  title: "jadwalin.id",
  description: "Penjadwalan, tiket, dan pembayaran untuk bisnis jasa di Indonesia.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser().catch(() => null);
  const superadmin = user ? await userIsSuperadmin(user.id).catch(() => false) : false;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="id" suppressHydrationWarning className={`${figtree.variable} ${geistMono.variable}`}>
      <head>
        {/* Terapkan pilihan tema (Terang/Gelap) sebelum cat pertama supaya tidak berkedip. Landing "/" default terang kecuali pengguna memilih "Otomatis". */}
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem("jd-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);else if(t!=="auto"&&location.pathname==="/")document.documentElement.setAttribute("data-theme","light")}catch(e){}` }} />
      </head>
      <body>
        <Suspense fallback={null}><NavProgress /></Suspense>
        <header className="site-header">
          <div className="inner">
            <a href="/" className="brand"><span className="mark" aria-hidden="true">j</span><span>jadwalin<span className="dot">.id</span></span></a>
            <nav className="top-nav" aria-label="Akun">
              {user ? (
                <>
                  {superadmin && <a href="/admin" className="nav-dash">Admin</a>}
                  <a href="/dashboard" className="nav-dash">Dashboard</a>
                  <a href="/akun" className="user-chip" title={user.email}><span className="avatar xs" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span><span className="user-name">{user.name.split(" ")[0]}</span></a>
                  <LogoutButton />
                </>
              ) : (
                <>
                  <a href="/masuk">Masuk</a>
                  <a href="/daftar" className="btn btn-sm">Daftar</a>
                </>
              )}
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <div className="inner">
            <small>© jadwalin.id · penjadwalan untuk bisnis jasa di Indonesia</small>
            <small className="foot-links"><a href="/syarat">Syarat</a><a href="/privasi">Privasi</a><a href="/refund">Refund</a><a href="/dpa">DPA</a><a href="/penggunaan-wajar">Penggunaan wajar</a><a href="/tentang">Identitas usaha</a></small>
          </div>
        </footer>
      </body>
    </html>
  );
}
