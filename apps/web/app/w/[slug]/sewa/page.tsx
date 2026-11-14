import { listMyWorkspaces } from "@jadwalin/core";
import { listOrders } from "@jadwalin/module-rental";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { FeatureOff } from "@/components/feature-off";
import { fmtDateTime, fmtIdr } from "@/lib/format";
import { setOrderStatusAction } from "@/lib/rental-actions";
import { getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

const DP: Record<string, string> = { pending: "DP menunggu dibayar", awaiting_verification: "Bukti DP menunggu verifikasi", paid: "DP lunas", expired: "DP kedaluwarsa", cancelled: "DP dibatalkan" };
const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Menunggu", tone: "warn" },
  confirmed: { label: "Dikonfirmasi", tone: "ok" },
  active: { label: "Sedang disewa", tone: "ok" },
  completed: { label: "Selesai", tone: "" },
  cancelled: { label: "Dibatalkan", tone: "" },
  rejected: { label: "Ditolak", tone: "" },
};

export default async function SewaPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; semua?: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const { error, semua } = await searchParams;
  const mine = (await listMyWorkspaces(getPool(), user.id)).find((w) => w.slug === slug);
  if (!mine) notFound();
  if (!mine.features.sewa) return <FeatureOff feature="sewa" slug={slug} canManage={mine.role !== "staff"} />;
  const orders = await listOrders(getPool(), { userId: user.id, slug }, semua ? "all" : "open");
  const act = (id: string, to: string) => setOrderStatusAction.bind(null, slug, id, to);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Pesanan sewa</h1>
          <p>Konfirmasi permintaan pelanggan, lalu tandai saat barang diambil dan dikembalikan. Untuk pesanan ber-DP, verifikasi bukti di menu Pembayaran. Sisa pembayaran dan jaminan diselesaikan langsung antara Anda dan penyewa.</p>
        </div>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      <nav className="chips">
        <Link href={`/w/${slug}/sewa`} className={semua ? "" : "on"}>Aktif</Link>
        <Link href={`/w/${slug}/sewa?semua=1`} className={semua ? "on" : ""}>Semua riwayat</Link>
      </nav>
      {orders.length === 0 && <div className="empty"><strong>Belum ada pesanan{semua ? "" : " aktif"}.</strong><small>Pesanan dari katalog publik Anda akan muncul di sini dan menambah angka di menu.</small></div>}
      <div className="list">
        {orders.map((o) => {
          const st = STATUS[o.status] ?? { label: o.status, tone: "" };
          const wa = o.clientPhone ? `https://wa.me/${o.clientPhone.replace(/\D/g, "")}` : null;
          return (
            <div className="card pay-row" key={o.id}>
              <div className="pay-info">
                <strong>{o.productName}</strong> <small>unit #{o.unitNo}</small>
                <div>{o.startDate} s.d. {o.endDate} · {o.days} hari · <strong>{fmtIdr(o.totalIdr)}</strong>{o.dpIdr > 0 && <> · DP {fmtIdr(o.dpIdr)} <span className={`badge ${o.dpStatus === "paid" ? "ok" : o.dpStatus === "awaiting_verification" ? "warn" : ""}`}>{DP[o.dpStatus ?? ""] ?? "DP"}</span></>}</div>
                <small>{o.clientName ?? "Pelanggan"} · {o.clientEmail}{wa && <> · <a href={wa} target="_blank" rel="noopener">WhatsApp {o.clientPhone}</a></>}</small>
                {o.customerNote && <small>Catatan: “{o.customerNote}”</small>}
                <small>Diajukan {fmtDateTime(o.createdAt, mine.timezone)} · <span className={`badge ${st.tone}`}>{st.label}</span></small>
              </div>
              <div className="review">
                {o.status === "pending" && (
                  <div className="row-btns">
                    {o.dpStatus === "pending" || o.dpStatus === "awaiting_verification"
                      ? <Link className="btn" href={`/w/${slug}/pembayaran#verifikasi`}>{o.dpStatus === "awaiting_verification" ? "Verifikasi bukti DP →" : "Menunggu DP →"}</Link>
                      : <form action={act(o.id, "confirmed")}><button>Konfirmasi</button></form>}
                    <form action={act(o.id, "rejected")}><ConfirmButton className="link danger-link" message="Tolak pesanan ini? Pelanggan akan diberi tahu.">Tolak</ConfirmButton></form>
                  </div>
                )}
                {o.status === "confirmed" && (
                  <div className="row-btns">
                    <form action={act(o.id, "active")}><button>Barang diambil</button></form>
                    <form action={act(o.id, "cancelled")}><ConfirmButton className="link danger-link" message="Batalkan pesanan ini? Pelanggan akan diberi tahu dan unit dibebaskan.">Batalkan</ConfirmButton></form>
                  </div>
                )}
                {o.status === "active" && <form action={act(o.id, "completed")}><button>Barang kembali (selesai)</button></form>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
