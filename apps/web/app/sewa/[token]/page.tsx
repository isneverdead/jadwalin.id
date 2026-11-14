import { getManualPaymentView } from "@jadwalin/core";
import { getRentalByToken } from "@jadwalin/module-rental";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { CopyButton } from "@/components/copy-button";
import { ProofUploader } from "@/components/proof-uploader";
import { fmtIdr } from "@/lib/format";
import { cancelRentalAction } from "@/lib/rental-actions";
import { fmtDateTime } from "@/lib/format";
import { getPool, getStorage } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pesanan sewa — jadwalin.id", robots: { index: false } };

const TEXT: Record<string, { title: string; body: string; tone: string }> = {
  pending: { title: "Menunggu konfirmasi pemilik", body: "Permintaan Anda sudah diterima dan unitnya kami tahan. Pemilik akan mengonfirmasi; buka kembali halaman ini untuk melihat statusnya.", tone: "warn" },
  confirmed: { title: "Pesanan dikonfirmasi", body: "Siapkan identitas dan uang jaminan saat mengambil barang. Pembayaran diselesaikan langsung dengan pemilik.", tone: "ok" },
  active: { title: "Barang sedang disewa", body: "Barang sudah Anda ambil. Kembalikan sesuai tanggal yang disepakati.", tone: "ok" },
  completed: { title: "Sewa selesai", body: "Terima kasih telah menyewa.", tone: "" },
  cancelled: { title: "Pesanan dibatalkan", body: "Pesanan ini sudah dibatalkan dan unitnya dibebaskan.", tone: "" },
  rejected: { title: "Pesanan tidak dapat dipenuhi", body: "Pemilik tidak dapat memenuhi pesanan ini. Silakan pilih tanggal lain.", tone: "" },
};

export default async function SewaTokenPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string; baru?: string }> }) {
  const { token } = await params;
  const { error, baru } = await searchParams;
  const o = await getRentalByToken(getPool(), token);
  if (!o) notFound();
  const manual = o.dpIdr > 0 ? await getManualPaymentView(getPool(), getStorage(), token) : null;
  const dpDue = Boolean(manual && manual.payment.status === "pending" && o.status === "pending");
  const dpWait = Boolean(manual && manual.payment.status === "awaiting_verification" && o.status === "pending");
  const base = TEXT[o.status] ?? { title: o.status, body: "", tone: "" };
  const t = dpDue
    ? { title: "Selesaikan DP", body: `Unit Anda ditahan sampai ${fmtDateTime(manual!.payment.expiresAt, "Asia/Jakarta")} WIB. Bayar DP lalu unggah buktinya di bawah.`, tone: "warn" }
    : dpWait
      ? { title: "Bukti DP diterima", body: "Pemilik sedang memeriksa bukti DP Anda. Unit tetap ditahan; buka kembali halaman ini untuk melihat konfirmasinya.", tone: "warn" }
      : o.status === "pending" && o.dpIdr === 0
        ? { ...base, body: "Permintaan Anda sudah diterima dan unitnya kami tahan. Pemilik akan mengonfirmasi; buka kembali halaman ini untuk melihat statusnya." }
        : o.status === "confirmed"
          ? { ...base, body: o.depositIdr > 0 ? `Siapkan identitas dan uang jaminan ${fmtIdr(o.depositIdr)} saat mengambil barang${o.dpIdr > 0 ? "; sisa pembayaran diselesaikan dengan pemilik" : ""}.` : `Siapkan identitas saat mengambil barang${o.dpIdr > 0 ? "; sisa pembayaran diselesaikan dengan pemilik" : ""}.` }
          : base;
  return (
    <>
      <h1>{baru ? "Permintaan sewa terkirim" : t.title}</h1>
      <div className={`notice ${t.tone}`} role="status"><strong>{t.title}.</strong> {t.body}</div>
      <section className="panel">
        <div className="panel-head"><h2>{o.productName}</h2><p>{o.workspace.name}</p></div>
        <div className="list">
          <div className="list-row"><span className="grow"><strong>Tanggal sewa</strong><small>{o.startDate} s.d. {o.endDate} ({o.days} hari)</small></span></div>
          <div className="list-row"><span className="grow"><strong>Perkiraan total</strong><small>{o.days} × {fmtIdr(o.pricePerDayIdr)} = {fmtIdr(o.totalIdr)}</small></span></div>
          {o.dpIdr > 0 && <div className="list-row"><span className="grow"><strong>DP</strong><small>{fmtIdr(o.dpIdr)}{manual?.payment.status === "paid" ? " · sudah diterima ✓" : ""} · sisa {fmtIdr(o.totalIdr - o.dpIdr)} dibayar saat ambil/kembali sesuai kesepakatan</small></span></div>}
          {o.depositIdr > 0 && <div className="list-row"><span className="grow"><strong>Uang jaminan</strong><small>{fmtIdr(o.depositIdr)} diserahkan saat mengambil barang dan dikembalikan saat barang kembali</small></span></div>}
        </div>
        {dpDue && manual && (
          <div className="pay-box" aria-label="Pembayaran DP">
            <p>Bayar <strong>{fmtIdr(manual.payment.amountIdr)}</strong> ke salah satu metode di bawah, lalu unggah bukti pembayaran.</p>
            {manual.proof?.status === "rejected" && <p className="error" role="alert">Bukti sebelumnya ditolak: {manual.proof.rejectReason}. Silakan unggah ulang.</p>}
            <ol className="pay-steps pay-steps-sm" aria-label="Langkah pembayaran">
              <li><span className="pay-step-n" aria-hidden="true">1</span><span>Transfer tepat <b>{fmtIdr(manual.payment.amountIdr)}</b></span></li>
              <li><span className="pay-step-n" aria-hidden="true">2</span><span>Simpan bukti (foto atau PDF)</span></li>
              <li><span className="pay-step-n" aria-hidden="true">3</span><span>Unggah di bawah; statusnya tampil di halaman ini</span></li>
            </ol>
            <div className="methods">
              {manual.methods.map((m) => (
                <div className="method" key={m.id}>
                  <strong>{m.label}</strong>
                  {m.accountName && <div>a.n. {m.accountName}</div>}
                  {m.accountNumber && <div className="acct"><code>{m.accountNumber}</code> <CopyButton text={m.accountNumber} /></div>}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {m.qrisUrl && <img className="qris" src={m.qrisUrl} alt={`QRIS ${m.label}`} />}
                  {m.instructions && <small>{m.instructions}</small>}
                </div>
              ))}
            </div>
            {manual.canUpload && <ProofUploader token={token} />}
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {o.canCancel && (
          <form action={cancelRentalAction.bind(null, token)}>
            <ConfirmButton className="link danger-link" message="Batalkan pesanan sewa ini?">Batalkan pesanan</ConfirmButton>
          </form>
        )}
      </section>
      <p><Link href={`/${o.workspace.slug}`}>← Kembali ke katalog {o.workspace.name}</Link></p>
      <p><small>Simpan tautan ini; hanya Anda yang memilikinya. Pembayaran dilakukan langsung ke pemilik; jadwalin.id tidak memproses uang.</small></p>
    </>
  );
}
