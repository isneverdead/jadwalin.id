import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

// CSP ber-nonce butuh render dinamis per permintaan (lihat middleware.ts).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "jadwalin.id",
  description: "Penjadwalan, tiket, dan pembayaran untuk bisnis jasa di Indonesia.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>
        <header className="site-header">
          <div className="inner">
            <a href="/" className="brand"><span className="mark" aria-hidden="true">j</span><span>jadwalin<span className="dot">.id</span></span></a>
          </div>
        </header>
        <main>{children}</main>
        <footer className="legal-footer">
          <small><a href="/syarat">Syarat</a> · <a href="/privasi">Privasi</a> · <a href="/refund">Refund</a> · <a href="/dpa">DPA</a> · <a href="/penggunaan-wajar">Penggunaan wajar</a> · <a href="/tentang">Identitas usaha</a></small>
        </footer>
      </body>
    </html>
  );
}
