import { PLANS, adminListInvoices, waLink, type AdminInvoiceRow } from "@jadwalin/core";
import Link from "next/link";
import { fmtDateTime, fmtIdr } from "@/lib/format";
import { reviewInvoiceAction } from "@/lib/admin-actions";
import { ConfirmButton } from "@/components/confirm-button";
import { getPool, requireSuperadmin, superadminEmails } from "@/lib/server";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { pending: "Menunggu bukti", awaiting_verification: "Menunggu verifikasi", paid: "Lunas", rejected: "Ditolak", cancelled: "Dibatalkan" };
const per = (m: number) => (m === 12 ? "tahunan" : "bulanan");

/** Kabar ke pemilik usaha lewat WhatsApp (nomor profil, atau nomor kontak usaha); kamu yang menekan Kirim. */
function ownerText(r: AdminInvoiceRow): string {
  const head = `Halo ${r.requesterName}, terkait upgrade paket ${PLANS[r.plan].label} ${per(r.months)} untuk "${r.workspaceName}" (kode ${r.code}, ${fmtIdr(r.amountIdr)}).`;
  if (r.status === "paid") return `${head} Pembayaran sudah kami verifikasi dan paket Anda aktif. Terima kasih!`;
  if (r.status === "rejected") return `${head} Mohon maaf, pembayaran belum dapat kami terima${r.rejectReason ? ` (${r.rejectReason})` : ""}. Silakan hubungi kami bila ada pertanyaan.`;
  if (r.status === "awaiting_verification") return `${head} Bukti transfer sudah kami terima dan sedang kami periksa.`;
  return `${head} Kami belum menerima bukti transfernya. Transfer ke BCA 2490405715 a.n. Fariz Akbar Shalahhuddin, lalu unggah buktinya di halaman Paket.`;
}

export default async function UpgradePage({ searchParams }: { searchParams: Promise<{ error?: string; semua?: string }> }) {
  const admin = await requireSuperadmin();
  const { error, semua } = await searchParams;
  const rows = await adminListInvoices(getPool(), admin.id, superadminEmails(), semua ? "all" : "open");
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Upgrade paket</h2>
        <nav className="chips"><Link href="/admin/upgrade" className={semua ? "" : "on"}>Perlu tindakan</Link><Link href="/admin/upgrade?semua=1" className={semua ? "on" : ""}>Semua</Link></nav>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {rows.length === 0 && <div className="empty"><strong>{semua ? "Belum ada tagihan." : "Tidak ada upgrade yang menunggu."}</strong></div>}
      {rows.map((r) => {
        const phone = r.requesterPhone ?? r.contactPhone;
        return (
          <div className="card pay-row" key={r.id}>
            <div className="pay-info">
              <strong>{r.workspaceName}</strong> <small>jadwalin.id/{r.workspaceSlug}</small>
              <div>{r.code} · {PLANS[r.plan].label} {per(r.months)} · <strong>{fmtIdr(r.amountIdr)}</strong></div>
              <small>{r.requesterName} · {r.requesterEmail}{phone ? ` · +${phone}` : ""}</small>
              <small>Paket sekarang: {PLANS[r.currentPlan].label}{r.currentUntil ? ` sampai ${fmtDateTime(r.currentUntil, "Asia/Jakarta")}` : ""} · dibuat {fmtDateTime(r.createdAt, "Asia/Jakarta")}</small>
              <span className={`badge ${r.status === "paid" ? "ok" : r.status === "awaiting_verification" ? "warn" : ""}`}>{STATUS[r.status]}</span>
              {r.hasProof && <small><a href={`/admin/upgrade/bukti/${r.id}`} target="_blank" rel="noopener">Lihat bukti transfer{r.proofNote ? ` — “${r.proofNote}”` : ""}</a></small>}
              {r.rejectReason && <small className="warn">Ditolak: {r.rejectReason}</small>}
              {phone && <small><a href={waLink(phone, ownerText(r))} target="_blank" rel="noopener">Kabari pemilik lewat WhatsApp ↗</a></small>}
            </div>
            {(r.status === "awaiting_verification" || r.status === "pending") && (
              <form action={reviewInvoiceAction.bind(null, r.id)} className="review">
                <input name="reason" placeholder="Alasan bila ditolak" maxLength={200} aria-label="Alasan penolakan" />
                <div className="row-btns">
                  <button name="decision" value="approve">{r.status === "pending" ? "Tandai lunas" : "Setujui & aktifkan paket"}</button>
                  <ConfirmButton name="decision" value="reject" className="link danger-link" message="Tolak pembayaran ini? Pemilik akan diminta membuat tagihan baru.">Tolak</ConfirmButton>
                </div>
              </form>
            )}
          </div>
        );
      })}
    </section>
  );
}
