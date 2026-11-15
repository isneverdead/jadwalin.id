import { listPublicSlots } from "@jadwalin/core";
import { loadTurnstileEnv } from "@jadwalin/config";
import { listMyTickets } from "@jadwalin/module-tickets";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Turnstile } from "@/components/turnstile";
import { bookAction } from "@/lib/booking-actions";
import { BookCta } from "@/components/book-cta";
import { SlotPicker } from "@/components/slot-picker";
import { fmtIdr, toPickerDays, tzLabel } from "@/lib/format";
import { currentUser, getPool } from "@/lib/server";

export const dynamic = "force-dynamic";

const KIND_LABEL = { link: "Video / online", phone: "Telepon", in_person: "Tatap muka" } as const;

export default async function BookPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; type: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { slug, type } = await params;
  const { error } = await searchParams;
  const pool = getPool();
  const data = await listPublicSlots(pool, slug, type);
  if (!data) notFound();
  const { workspace, type: mt, paymentReady } = data;
  const tz = workspace.timezone;
  const { days, todayKey } = toPickerDays(data.slots, tz);

  const user = await currentUser();
  const myTickets = user
    ? (await listMyTickets(pool, user.id, slug).catch(() => null))?.tickets.filter((t) => t.status !== "closed") ?? []
    : [];
  const turnstile = loadTurnstileEnv();
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <div className="wide">
      <p className="crumb"><Link href={`/${workspace.slug}`}>← {workspace.name}</Link></p>
      <div className="book-grid">
        <aside className="book-aside">
          <div className="avatar" aria-hidden="true">{workspace.name.slice(0, 1).toUpperCase()}</div>
          <p className="aside-org">{workspace.name}</p>
          <h1>{mt.title}</h1>
          <ul className="facts">
            <li><span aria-hidden="true">⏱</span> {mt.durationMin} menit</li>
            <li><span aria-hidden="true">{mt.locationKind === "phone" ? "☎" : mt.locationKind === "in_person" ? "⌖" : "▶"}</span> {KIND_LABEL[mt.locationKind]}</li>
            <li><span aria-hidden="true">◷</span> Zona waktu {tzLabel(tz)}</li>
            {mt.depositIdr > 0 && <li className="price">DP {fmtIdr(mt.depositIdr)} <small>dibayar setelah memilih jadwal, langsung ke penyedia jasa</small></li>}
          </ul>
        </aside>

        <section className="book-main">
          {!paymentReady && (
            <div className="notice warn" role="alert"><strong>Layanan ini belum bisa dipesan online.</strong> Penyedia jasa belum mengatur cara pembayaran DP. Silakan hubungi {workspace.name} langsung.</div>
          )}
          {days.length === 0 ? (
            <div className="empty">
              <p><strong>Belum ada jadwal kosong.</strong></p>
              <p>Coba lagi nanti atau kirim pesan lewat <Link href={`/${workspace.slug}`}>halaman {workspace.name}</Link>.</p>
            </div>
          ) : (
            <form action={bookAction.bind(null, workspace.slug, mt.slug)}>
              <fieldset className="step">
                <legend><span className="num">1</span> Pilih tanggal &amp; jam</legend>
                <SlotPicker days={days} todayKey={todayKey} tzName={tzLabel(tz)} />
              </fieldset>

              <fieldset className="step">
                <legend><span className="num">2</span> Data Anda</legend>
                {user ? (
                  <>
                    <p className="whoami">Memesan sebagai <strong>{user.name}</strong> <small>({user.email})</small></p>
                    {myTickets.length > 0 && (
                      <label>Kaitkan dengan tiket
                        <select name="ticket" defaultValue="">
                          <option value="">Buat tiket baru</option>
                          {myTickets.map((t) => <option key={t.number} value={t.number}>#{t.number} {t.title}</option>)}
                        </select>
                      </label>
                    )}
                  </>
                ) : (
                  <>
                    <div className="two">
                      <label>Nama<input name="name" required minLength={2} maxLength={100} autoComplete="name" placeholder="Nama lengkap" /></label>
                      <label><span>Nomor HP / WhatsApp <small>· kabar tentang booking Anda</small></span><input name="phone" type="tel" required autoComplete="tel" inputMode="tel" placeholder="0812…" /></label>
                    </div>
                  </>
                )}
                {/* Tanpa isian "Topik": judul layanan dipakai sebagai topik (tidak relevan untuk salon, lapangan, dll). */}
                <input type="hidden" name="topic" value={mt.title} />
                <label><span>Pesan untuk {workspace.name} <small>(opsional)</small></span><textarea name="notes" rows={2} maxLength={2000} placeholder="mis. preferensi, alergi, atau pertanyaan" /></label>

                {/* Honeypot: manusia tidak melihatnya; bot biasanya mengisinya. */}
                <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", height: 0, overflow: "hidden" }}>
                  <label>Situs web<input name="website" tabIndex={-1} autoComplete="off" /></label>
                </div>

                {!user && (
                  <label className="check"><input type="checkbox" name="privacy" required /><span>Saya telah membaca <a href="/privasi" target="_blank" rel="noopener">pemberitahuan privasi</a>; data saya diproses oleh {workspace.name} dan jadwalin.id untuk keperluan booking ini.</span></label>
                )}
                {!user && turnstile.siteKey && <Turnstile siteKey={turnstile.siteKey} nonce={nonce} />}
                {error && <p className="error" role="alert">{error}</p>}
                {!user && <small className="fine">Tanpa akun: setelah memesan Anda mendapat tautan kelola (batal/ubah jadwal). Simpan tautannya; Anda juga bisa mengirimkannya ke WhatsApp sendiri setelah memesan.</small>}
              </fieldset>
              {/* Tombol pesan menempel di dasar layar supaya selalu terlihat, tidak perlu menggulir sampai bawah. */}
              <BookCta>
                <button className="cta" disabled={!paymentReady}>{mt.depositIdr > 0 ? `Lanjut ke pembayaran · ${fmtIdr(mt.depositIdr)}` : "Pesan jadwal"}</button>
              </BookCta>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
