import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/server";
import { LandingFeatures } from "@/components/landing-features";
import { LandingDemo } from "@/components/landing-demo";
import { LandingThemeToggle } from "@/components/landing-theme-toggle";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "jadwalin.id — Apapun bisnisnya, jadwalin.id solusinya",
  description: "Halaman booking dengan merek Anda: klien pilih tanggal dan jam, bayar DP, slot terkunci, pengingat otomatis. Untuk lapangan, studio, klinik, kelas, dan jasa perorangan.",
};

const WA = "https://wa.me/628567500965?text=" + encodeURIComponent("Halo Jadwalin, saya tertarik mencoba booking online untuk usaha saya.");

const SEGMENTS = ["Lapangan olahraga", "Studio pilates & yoga", "Studio foto", "Klinik", "Bimbel", "Tutor & coach", "Sewa barang"] as const;

const STEPS = [
  ["Daftar", "Buat akun dan beri nama usaha Anda. Alamatnya jadwalin.id/nama-usaha."],
  ["Atur layanan & jam", "Isi layanan, harga, DP, dan jam buka. Slot yang terisi otomatis tertutup."],
  ["Bagikan tautan", "Tempel di bio Instagram, status WhatsApp, atau kirim langsung ke klien."],
  ["Terima booking + DP", "Klien transfer DP dan unggah bukti. Anda cek, lalu slot terkunci."],
] as const;

const FEATURES = [
  ["Halaman booking atas nama Anda", "Klien memilih layanan, tanggal, dan jam sendiri. Anda tidak perlu membalas chat satu per satu.", "wide"],
  ["Anti-bentrok di database", "Dua klien tidak bisa memesan jam yang sama, bahkan saat memesan bersamaan.", "wide"],
  ["DP manual yang tertib", "Rekening, QRIS, atau e-wallet Anda sendiri. Uang tidak lewat jadwalin.", ""],
  ["Dashboard pemilik", "Jadwal, bukti bayar yang menunggu verifikasi, dan riwayat dalam satu tempat. Bisa multi-admin.", ""],
  ["Sewa barang", "Katalog sewa per hari untuk motor, mobil, kamera, dan perlengkapan, lengkap dengan DP.", ""],
] as const;

const PLANS = [
  { name: "Studio", setup: "1 jt", normal: "2 jt", month: "250 rb", note: "Studio pilates, yoga, foto" },
  { name: "Lapangan & Kelas", setup: "1,5 jt", normal: "3 jt", month: "400 rb", note: "Banyak lapangan, ruangan, atau kelas", pick: true },
  { name: "Klinik", setup: "2,5 jt", normal: "5 jt", month: "600 rb", note: "Banyak dokter atau terapis" },
] as const;

export default async function Home() {
  if (await currentUser().catch(() => null)) redirect("/dashboard");
  return (
    <div className="lp">
      <LandingThemeToggle />
      <section className="lp-hero">
        <div className="lp-hero-copy">
          <p className="lp-kicker">Penjadwalan untuk bisnis jasa di Indonesia</p>
          <h1>Apapun bisnisnya, <em>jadwalin.id</em> solusinya.</h1>
          <p className="lp-lead">Klien booking sendiri lewat halaman dengan nama usaha Anda, bayar DP, dan jadwal Anda tetap rapi. Tanpa bentrok, tanpa balas chat satu per satu.</p>
          <div className="lp-actions">
            <Link className="btn" href="/daftar">Coba gratis</Link>
            <a className="btn btn-ghost" href={WA} target="_blank" rel="noopener">Chat WhatsApp</a>
          </div>
          <p className="lp-fine">Promo setup sampai 31 Des 2026 untuk 10 bisnis pertama · coba gratis 14 hari · garansi 30 hari · tanpa kontrak</p>
        </div>

        <div className="lp-mock" aria-hidden="true">
          <div className="lp-mock-card">
            <div className="lp-mock-top"><span className="lp-mock-dot" /><b>jadwalin.id/nama-usaha</b></div>
            <p className="lp-mock-label">Pilih jam</p>
            <div className="lp-mock-slots">
              <span className="off">08.00</span><span className="off">09.00</span><span className="on">10.00</span><span>11.00</span><span>13.00</span><span className="off">14.00</span>
            </div>
            <div className="lp-mock-dp"><span>DP</span><b>Transfer + unggah bukti</b></div>
            <div className="lp-mock-cta">Booking</div>
          </div>
          <div className="lp-mock-chip lp-mock-chip-a">Slot terkunci</div>
          <p className="lp-mock-note">Contoh tampilan</p>
        </div>

        <div className="lp-stamp" role="note">
          <span className="lp-stamp-top">Awas nyasarrr</span>
          <b>ujungnya .id</b>
          <span className="lp-stamp-sub">Yang .com beda circle, bestie.</span>
        </div>
      </section>

      <section className="lp-seg" aria-label="Cocok untuk">
        <ul>
          {SEGMENTS.map((x) => <li key={x}>{x}</li>)}
        </ul>
      </section>

      <section aria-labelledby="demo" className="lp-block">
        <h2 id="demo">Dari klien sampai jadwal terkunci.</h2>
        <p className="lp-sub">Satu alur, dua sisi: klien booking dan bayar DP, Anda cukup verifikasi.</p>
        <LandingDemo />
      </section>

      <section aria-labelledby="alur" className="lp-block">
        <h2 id="alur">Empat langkah, lalu jalan.</h2>
        <ol className="lp-steps">
          {STEPS.map(([t, d], i) => (
            <li key={t}><span className="lp-step-n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span><strong>{t}</strong><p>{d}</p></li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="fitur" className="lp-block">
        <h2 id="fitur">Yang Anda dapat</h2>
        <LandingFeatures items={FEATURES} />
      </section>

      <section aria-labelledby="harga" className="lp-block">
        <h2 id="harga">Harga jujur, tanpa kontrak.</h2>
        <p className="lp-sub">Bayar setup sekali, lalu biaya bulanan. Siap pakai dalam 1–2 minggu. Garansi 30 hari.</p>
        <div className="lp-plans">
          {PLANS.map((p) => (
            <div className={`lp-plan${"pick" in p ? " pick" : ""}`} key={p.name}>
              <h3>{p.name}</h3>
              <p className="lp-plan-note">{p.note}</p>
              <p className="lp-price"><small>Rp</small>{p.setup}<s>Rp {p.normal}</s></p>
              <p className="lp-plan-cap">setup sekali bayar, harga promo</p>
              <p className="lp-month"><b>Rp {p.month}</b> per bulan</p>
            </div>
          ))}
          <div className="lp-plan solo">
            <h3>Perorangan</h3>
            <p className="lp-plan-note">Tutor, coach, MUA, konsultan</p>
            <p className="lp-price">Tanpa setup</p>
            <p className="lp-month"><b>Rp 49 rb</b> per bulan, atau <b>Rp 399 rb</b> per tahun</p>
          </div>
        </div>
        <p className="lp-fine">Promo berlaku sampai 31 Des 2026 untuk 10 bisnis pertama. DP klien Anda masuk langsung ke rekening Anda; jadwalin tidak menampung uang pihak ketiga.</p>
      </section>

      <section className="lp-cta">
        <h2>Mau dicoba untuk usaha Anda?</h2>
        <p>Ceritakan bidang usaha Anda, kami bantu siapkan halaman bookingnya.</p>
        <div className="lp-actions">
          <a className="btn" href={WA} target="_blank" rel="noopener">Chat WhatsApp 0856-7500-965</a>
          <Link className="btn btn-ghost" href="/daftar">Daftar</Link>
          <Link className="btn btn-ghost" href="/masuk">Masuk</Link>
        </div>
        <small>Dengan memakai jadwalin Anda menyetujui <Link href="/syarat">Syarat</Link> dan <Link href="/privasi">Kebijakan Privasi</Link>. Identitas penyelenggara ada di <Link href="/tentang">halaman identitas usaha</Link>.</small>
      </section>
    </div>
  );
}
