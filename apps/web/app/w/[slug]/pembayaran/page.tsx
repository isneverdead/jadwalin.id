import { listProducts } from "@jadwalin/module-rental";
import { AppError, bookingWhatsAppLink, listManualPayments, listMeetingTypes, listMyWorkspaces, listPaymentMethods } from "@jadwalin/core";
import Link from "next/link";
import { ConfirmButton } from "@/components/confirm-button";
import { notFound } from "next/navigation";
import { FeatureOff } from "@/components/feature-off";
import { QrisUploader } from "@/components/qris-uploader";
import { deleteMethodAction, reviewPaymentAction, saveMethodAction, toggleMethodAction } from "@/lib/payment-actions";
import { fmtDateTime, fmtIdr } from "@/lib/format";
import { appBaseUrl, getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

const KIND = { bank_transfer: "Transfer bank", qris: "QRIS", ewallet: "E-wallet", other: "Lainnya" } as const;
const STATUS: Record<string, string> = { pending: "Menunggu pembayaran", awaiting_verification: "Menunggu verifikasi", paid: "Lunas", expired: "Kedaluwarsa", refunded: "Dikembalikan", partially_refunded: "Sebagian dikembalikan", refund_pending: "Refund diproses", cancelled: "Dibatalkan", failed: "Gagal" };

export default async function PembayaranPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; semua?: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const { error, semua } = await searchParams;
  const actor = { userId: user.id, slug };
  const mine = (await listMyWorkspaces(getPool(), user.id)).find((w) => w.slug === slug);
  if (!mine) notFound();
  const canManage = mine.role === "owner" || mine.role === "admin";
  if (!mine.features.pembayaran) return <FeatureOff feature="pembayaran" slug={slug} canManage={canManage} />;
  const [methods, rows, types, products] = await Promise.all([
    listPaymentMethods(getPool(), actor).catch((e) => { if (e instanceof AppError) return null; throw e; }),
    listManualPayments(getPool(), actor, semua ? "all" : "open"),
    mine.features.jadwal ? listMeetingTypes(getPool(), actor) : Promise.resolve([]),
    mine.features.sewa ? listProducts(getPool(), actor).catch(() => []) : Promise.resolve([]),
  ]);
  if (!methods) notFound();
  const waiting = rows.filter((r) => r.status === "awaiting_verification").length;

  const none = methods.filter((m) => m.active).length === 0;
  const dpTypes = types.filter((t) => t.active && t.depositIdr > 0);
  const dpProducts = products.filter((p) => p.active && p.dpPercent > 0);
  const steps = [
    { done: !none, label: "Tambah metode pembayaran", hint: "Rekening, QRIS, atau e-wallet tempat pelanggan membayar DP.", href: "#metode" },
    mine.features.jadwal
      ? { done: dpTypes.length > 0 || dpProducts.length > 0, label: mine.features.sewa ? "Isi DP di layanan atau produk" : "Isi DP di layanan", hint: mine.features.sewa ? "Isi kolom DP pada layanan (Jadwal & layanan) atau produk (Produk sewa)." : "Buka Jadwal & layanan, isi kolom DP pada layanan yang meminta DP.", href: `/w/${slug}/jadwal` }
      : { done: dpProducts.length > 0, label: "Isi DP di produk sewa", hint: "Buka Produk sewa, isi kolom “DP (% dari total)” pada produk yang meminta DP.", href: `/w/${slug}/produk` },
    { done: rows.some((r) => r.status === "paid"), label: "Verifikasi bukti dari pelanggan", hint: "Bukti yang masuk muncul di bawah; cek lalu klik Konfirmasi lunas.", href: "#verifikasi" },
  ];
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Pembayaran</h1>
          <p>jadwalin.id tidak memproses uang. Pelanggan membayar langsung ke Anda lewat metode di bawah, lalu mengirim bukti untuk Anda verifikasi.</p>
        </div>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {steps.some((x) => !x.done) && (
        <ol className="pay-steps" aria-label="Cara memakai DP">
          {steps.map((x, i) => (
            <li key={x.label} className={x.done ? "done" : ""}>
              <span className="pay-step-n" aria-hidden="true">{x.done ? "✓" : i + 1}</span>
              <span><strong><Link href={x.href}>{x.label}</Link></strong><small>{x.hint}</small></span>
            </li>
          ))}
        </ol>
      )}
      {none && <p className="notice warn">Belum ada metode pembayaran aktif, jadi layanan atau produk ber-DP belum bisa dipesan. Tambahkan di bagian “Metode pembayaran Anda” di bawah.</p>}

      <section className="panel" id="verifikasi">
        <div className="panel-head">
          <h2>{semua ? "Semua riwayat" : "Menunggu tindakan"} {waiting > 0 && <span className="badge">{waiting} bukti baru</span>}</h2>
          <nav className="chips">
            <Link href={`/w/${slug}/pembayaran`} className={semua ? "" : "on"}>Menunggu</Link>
            <Link href={`/w/${slug}/pembayaran?semua=1`} className={semua ? "on" : ""}>Semua riwayat</Link>
          </nav>
        </div>
        {rows.length === 0 && <div className="empty"><strong>Belum ada pembayaran {semua ? "" : "yang menunggu"}.</strong><small>Saat pelanggan memesan layanan atau produk ber-DP dan mengirim bukti, kartunya muncul di sini.</small></div>}
        <div className="list">
          {rows.map((r) => (
            <div className="card pay-row" key={r.paymentId}>
              <div className="pay-info">
                <strong>{r.clientName ?? "Pelanggan"}</strong> <small>{r.clientEmail}</small>
                <div>{r.typeTitle} · <strong>{fmtIdr(r.amountIdr)}</strong></div>
                <small>{r.startsAt ? fmtDateTime(r.startsAt, mine.timezone) : ""} · <span className={`badge ${r.status === "paid" ? "ok" : r.status === "awaiting_verification" ? "warn" : ""}`}>{STATUS[r.status] ?? r.status}</span></small>
                {r.proof && (
                  <div className="proof">
                    {r.proof.mime?.startsWith("image/") && (
                      // Pratinjau langsung: rute bukti memeriksa otorisasi lalu mengalihkan ke URL bertanda tangan (CSP img-src mengizinkan S3).
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="proof-img" src={`/w/${slug}/pembayaran/bukti/${r.proof.id}`} alt={`Bukti pembayaran ${r.clientName ?? ""}`} loading="lazy" />
                    )}
                    <a href={`/w/${slug}/pembayaran/bukti/${r.proof.id}`} target="_blank" rel="noopener">{r.proof.mime?.startsWith("image/") ? "Unduh ukuran penuh" : "Unduh bukti (PDF)"}</a>
                    {r.proof.note && <small>Catatan pelanggan: “{r.proof.note}”</small>}
                    {r.proof.status === "rejected" && <small className="warn">Ditolak: {r.proof.rejectReason}</small>}
                  </div>
                )}
              </div>
              {r.subjectType === "booking" && r.status !== "cancelled" && r.startsAt && <div className="row-btns"><a className="btn btn-ghost btn-sm" target="_blank" rel="noopener" href={bookingWhatsAppLink({ phone: r.clientPhone, clientName: r.clientName ?? "Pelanggan", wsName: mine.name, wsSlug: slug, typeTitle: r.typeTitle ?? "Booking", startsAt: r.startsAt, timezone: mine.timezone, bookingId: r.bookingId, baseUrl: appBaseUrl() })}>Kirim tautan booking lewat WhatsApp ↗</a></div>}
              {(r.status === "awaiting_verification" || r.status === "pending") && (
                <form action={reviewPaymentAction.bind(null, slug, r.paymentId)} className="review">
                  {r.status === "awaiting_verification" && <input name="reason" placeholder="Alasan bila ditolak" maxLength={200} aria-label="Alasan penolakan" />}
                  <div className="row-btns">
                    <button name="decision" value="accept">{r.status === "pending" ? "Tandai lunas" : "Konfirmasi lunas"}</button>
                    {r.status === "awaiting_verification" && <ConfirmButton name="decision" value="reject" className="link danger-link" message="Tolak bukti pembayaran ini? Pelanggan akan diminta mengirim ulang.">Tolak</ConfirmButton>}
                  </div>
                </form>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="panel" id="metode">
        <div className="panel-head"><h2>Metode pembayaran Anda</h2><p>Hanya pelanggan yang sudah memesan layanan berbayar yang melihat metode ini.</p></div>
        <div className="list">
          {methods.map((m) => (
            <div className="list-row" key={m.id}>
              <span className="grow">
                <strong>{m.label}</strong>
                <small>{KIND[m.kind as keyof typeof KIND]}{m.accountNumber ? ` · ${m.accountNumber}` : ""}{m.accountName ? ` a.n. ${m.accountName}` : ""}</small>
              </span>
              <span className={`badge ${m.active ? "ok" : ""}`}>{m.active ? "Aktif" : "Nonaktif"}</span>
              {canManage && (
                <span className="row-btns">
                  <form action={toggleMethodAction.bind(null, slug, m.id, !m.active)}><button className="link">{m.active ? "Nonaktifkan" : "Aktifkan"}</button></form>
                  <form action={deleteMethodAction.bind(null, slug, m.id)}><ConfirmButton className="link danger-link" message={`Hapus metode ${m.label}?`}>Hapus</ConfirmButton></form>
                </span>
              )}
            </div>
          ))}
        </div>
        {canManage && (
          <details className="fold" open={methods.length === 0}>
            <summary>+ Tambah metode pembayaran</summary>
            <form action={saveMethodAction.bind(null, slug)}>
              <label>Jenis
                <select name="kind" defaultValue="bank_transfer">
                  <option value="bank_transfer">Transfer bank</option>
                  <option value="qris">QRIS statis</option>
                  <option value="ewallet">E-wallet (GoPay, OVO, Dana, dll.)</option>
                  <option value="other">Lainnya (tunai, dll.)</option>
                </select>
              </label>
              <label>Nama metode<input name="label" required maxLength={40} placeholder="mis. BCA, QRIS Toko, GoPay" /></label>
              <div className="two">
                <label>Atas nama<input name="accountName" maxLength={80} placeholder="Nama pemilik rekening/akun" /></label>
                <label>Nomor rekening / akun<input name="accountNumber" maxLength={40} inputMode="numeric" placeholder="1234567890" /></label>
              </div>
              <QrisUploader slug={slug} />
              <label><span>Petunjuk <small>(opsional; wajib untuk “Lainnya”)</small></span><textarea name="instructions" rows={2} maxLength={500} placeholder="mis. Cantumkan nama pada berita transfer" /></label>
              <button>Simpan metode</button>
            </form>
          </details>
        )}
      </section>
    </>
  );
}
