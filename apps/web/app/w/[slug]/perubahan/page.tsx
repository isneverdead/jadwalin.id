import { listBookingRequests, listMyWorkspaces, waLink, type BookingRequestRow } from "@jadwalin/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FeatureOff } from "@/components/feature-off";
import { RefundProofUploader } from "@/components/refund-proof-uploader";
import { decideRequestAction } from "@/lib/change-actions";
import { fmtDateTime, fmtIdr } from "@/lib/format";
import { appBaseUrl, getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

const KIND = { cancel: "Pembatalan", reschedule: "Ubah jadwal" } as const;
const STATUS: Record<string, string> = { requested: "Menunggu keputusan", approved: "Disetujui, menunggu refund", completed: "Selesai", rejected: "Ditolak" };

/** Pesan WhatsApp siap kirim: penyedia menekan Kirim sendiri (wa.me, bukan API). */
function waText(r: BookingRequestRow, slug: string, base: string): string {
  const link = `${base}/booking/cari?u=${slug}&kode=${r.bookingCode} (buka lalu masukkan nomor HP Anda)`;
  const head = `Halo ${r.clientName}, terkait booking ${r.typeTitle} (kode ${r.bookingCode}).`;
  if (r.kind === "reschedule") {
    return r.status === "completed" ? `${head} Permintaan ubah jadwal Anda sudah kami setujui. Lihat jadwal baru: ${link}` : r.status === "rejected" ? `${head} Mohon maaf, permintaan ubah jadwal belum bisa kami setujui${r.decisionNote ? ` (${r.decisionNote})` : ""}. Detail: ${link}` : `${head} Permintaan ubah jadwal Anda kami terima dan sedang kami periksa. Status: ${link}`;
  }
  if (r.status === "completed") return `${head} Dana ${fmtIdr(r.refundAmountIdr ?? 0)} sudah kami transfer. Bukti transfer ada di halaman booking Anda: ${link}`;
  if (r.status === "approved") return `${head} Pembatalan Anda kami setujui. Dana ${fmtIdr(r.refundAmountIdr ?? 0)} akan kami transfer; buktinya akan tampil di: ${link}`;
  if (r.status === "rejected") return `${head} Mohon maaf, pembatalan belum bisa kami setujui${r.decisionNote ? ` (${r.decisionNote})` : ""}. Detail: ${link}`;
  return `${head} Pengajuan pembatalan Anda kami terima dan sedang kami periksa. Status: ${link}`;
}

export default async function PerubahanPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; semua?: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const { error, semua } = await searchParams;
  const mine = (await listMyWorkspaces(getPool(), user.id)).find((w) => w.slug === slug);
  if (!mine) notFound();
  const canManage = mine.role === "owner" || mine.role === "admin";
  if (!mine.features.jadwal) return <FeatureOff feature="jadwal" slug={slug} canManage={canManage} />;
  const rows = await listBookingRequests(getPool(), { userId: user.id, slug }, semua ? "all" : "open");
  const base = appBaseUrl().replace(/\/$/, "");

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Perubahan booking</h1>
          <p>Pengajuan pembatalan (khusus yang DP-nya sudah dibayar) dan permintaan ubah jadwal dari pelanggan. Setujui atau tolak; untuk refund, transfer sendiri lalu unggah buktinya. Pelanggan melihat statusnya di halaman booking.</p>
        </div>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="chips" role="group" aria-label="Saring">
        <Link href={`/w/${slug}/perubahan`} className={!semua ? "on" : ""}>Perlu tindakan</Link>
        <Link href={`/w/${slug}/perubahan?semua=1`} className={semua ? "on" : ""}>Semua</Link>
      </div>
      {rows.length === 0 ? (
        <div className="empty"><strong>{semua ? "Belum ada permintaan." : "Tidak ada yang perlu ditindaklanjuti."}</strong><small>Pengajuan dari pelanggan akan muncul di sini dan menambah lencana pada menu.</small></div>
      ) : (
        rows.map((r) => (
          <section className="panel" key={r.id} aria-label={`${KIND[r.kind]} ${r.clientName}`}>
            <div className="panel-head">
              <h2>{KIND[r.kind]} · {r.clientName}</h2>
              <span className={`badge ${r.status === "requested" ? "warn" : r.status === "completed" ? "ok" : ""}`}>{STATUS[r.status]}</span>
            </div>
            <div className="list">
              <div className="list-row"><span className="grow"><strong>{r.typeTitle}</strong><small>{fmtDateTime(r.startsAt, mine.timezone)} · kode {r.bookingCode}</small></span></div>
              {r.kind === "reschedule" && r.newStartsAt && <div className="list-row"><span className="grow"><strong>Minta pindah ke</strong><small>{fmtDateTime(r.newStartsAt, mine.timezone)}</small></span></div>}
              {r.reason && <div className="list-row"><span className="grow"><strong>Alasan pelanggan</strong><small>{r.reason}</small></span></div>}
              {r.kind === "cancel" && <div className="list-row"><span className="grow"><strong>DP terbayar</strong><small>{r.paidIdr ? fmtIdr(r.paidIdr) : "—"}</small></span></div>}
              {r.kind === "cancel" && r.refundAccount && <div className="list-row"><span className="grow"><strong>Tujuan refund</strong><small>{r.refundAccount}</small></span></div>}
              {r.refundAmountIdr !== null && r.status !== "requested" && <div className="list-row"><span className="grow"><strong>Refund</strong><small>{fmtIdr(r.refundAmountIdr)}{r.decisionNote ? ` · ${r.decisionNote}` : ""}</small></span></div>}
              {r.customerAck && <div className="list-row"><span className="grow"><strong>Konfirmasi pelanggan</strong><small>{r.customerAck === "received" ? "Dana sudah diterima ✓" : "Melaporkan dana BELUM masuk. Periksa dan hubungi pelanggan."}</small></span></div>}
            </div>

            {r.status === "requested" && (
              <form action={decideRequestAction.bind(null, slug, r.id)} className="decide">
                {r.kind === "cancel" && (
                  <label><span>Nominal refund (Rp) <small>kosongkan = refund penuh {r.paidIdr ? fmtIdr(r.paidIdr) : ""}; 0 = batal tanpa refund</small></span><input name="refund" inputMode="numeric" placeholder={String(r.paidIdr ?? "")} /></label>
                )}
                <label><span>Catatan untuk pelanggan <small>(wajib bila menolak)</small></span><input name="note" maxLength={300} placeholder={r.kind === "cancel" ? "Mis. dipotong biaya admin / DP tidak dapat dikembalikan" : "Mis. slot itu sudah dipesan klien tetap"} /></label>
                <div className="row-btns">
                  <button name="decision" value="approve">Setujui</button>
                  <button name="decision" value="reject" className="danger">Tolak</button>
                </div>
              </form>
            )}
            {r.status === "approved" && r.kind === "cancel" && (
              <>
                <p className="notice warn"><b>Langkah berikutnya:</b> transfer {fmtIdr(r.refundAmountIdr ?? 0)} ke tujuan refund di atas, lalu unggah buktinya. Booking baru batal setelah bukti diunggah.</p>
                <RefundProofUploader slug={slug} requestId={r.id} amount={fmtIdr(r.refundAmountIdr ?? 0)} />
              </>
            )}
            {r.clientPhone && (
              <p className="row-btns">
                <a className="btn btn-ghost" href={waLink(r.clientPhone, waText(r, slug, base))} target="_blank" rel="noopener">Kabari {r.clientName} lewat WhatsApp ↗</a>
                <small>Membuka WhatsApp dengan pesan siap kirim; Anda yang menekan Kirim.</small>
              </p>
            )}
          </section>
        ))
      )}
    </>
  );
}
