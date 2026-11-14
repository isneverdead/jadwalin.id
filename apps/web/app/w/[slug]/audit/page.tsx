import { AppError, listAuditLog, listMyWorkspaces } from "@jadwalin/core";
import { notFound } from "next/navigation";
import { getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

const GROUP: Record<string, string> = { auth: "Akun", availability: "Jadwal", booking: "Booking", client: "Klien", file: "Berkas", invitation: "Undangan", meeting_type: "Layanan", member: "Anggota", payment: "Pembayaran", payment_method: "Pembayaran", ticket: "Tiket", workspace: "Usaha", rental: "Sewa", rental_product: "Produk sewa", reservation: "Sewa" };
const TZ_LABEL: Record<string, string> = { "Asia/Jakarta": "WIB", "Asia/Makassar": "WITA", "Asia/Jayapura": "WIT" };
const ACTION: Record<string, string> = {
  "auth.sign_in": "Masuk ke akun",
  "auth.sign_in_failed": "Percobaan masuk gagal",
  "auth.sign_out": "Keluar dari akun",
  "auth.sign_up": "Mendaftar akun",
  "availability.override_added": "Menambah pengecualian tanggal",
  "availability.override_removed": "Menghapus pengecualian tanggal",
  "availability.replaced": "Mengubah jam kerja mingguan",
  "booking.cancelled": "Booking dibatalkan",
  "booking.cancelled_by_guest": "Booking dibatalkan oleh pelanggan",
  "booking.created": "Booking dibuat",
  "booking.created_client": "Booking dibuat oleh klien",
  "booking.created_public": "Booking dibuat dari halaman publik",
  "booking.rescheduled_by_guest": "Pelanggan mengubah jadwal booking",
  "client.added": "Klien ditambahkan",
  "client.self_registered": "Klien mendaftar sendiri",
  "file.deleted": "Berkas dihapus",
  "file.download_url_issued": "Tautan unduh berkas dibuat",
  "file.upload_requested": "Unggah berkas dimulai",
  "invitation.accepted": "Undangan diterima",
  "invitation.created": "Undangan dikirim",
  "invitation.revoked": "Undangan dibatalkan",
  "meeting_type.created": "Layanan ditambahkan",
  "meeting_type.activated": "Layanan diaktifkan",
  "meeting_type.deactivated": "Layanan dinonaktifkan",
  "meeting_type.hosts_set": "Pelayan layanan diubah",
  "member.removed": "Anggota dikeluarkan",
  "payment.proof_submitted": "Bukti pembayaran dikirim",
  "payment_method.created": "Metode pembayaran ditambahkan",
  "payment_method.deleted": "Metode pembayaran dihapus",
  "payment_method.updated": "Metode pembayaran diubah",
  "ticket.created": "Tiket dibuat",
  "workspace.created": "Usaha dibuat",
  "workspace.deleted": "Usaha dihapus",
  "workspace.features_updated": "Fitur usaha diubah",
  "meeting_type.updated": "Layanan diubah",
  "payment.confirmed_manual": "Pembayaran dikonfirmasi lunas",
  "payment.proof_rejected": "Bukti pembayaran ditolak",
  "payment_method.enabled": "Metode pembayaran diaktifkan",
  "payment_method.disabled": "Metode pembayaran dinonaktifkan",
  "rental.requested": "Permintaan sewa masuk",
  "rental.cancelled_by_guest": "Sewa dibatalkan oleh pelanggan",
  "rental_product.created": "Produk sewa ditambahkan",
  "rental_product.updated": "Produk sewa diubah",
  "rental_product.activated": "Produk sewa diaktifkan",
  "rental_product.deactivated": "Produk sewa dinonaktifkan",
  "reservation.confirmed": "Pesanan sewa dikonfirmasi",
  "reservation.active": "Barang sewa diambil",
  "reservation.completed": "Sewa selesai (barang kembali)",
  "reservation.cancelled": "Pesanan sewa dibatalkan",
  "reservation.rejected": "Pesanan sewa ditolak",
};

export default async function AuditPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const rows = await listAuditLog(getPool(), { userId: user.id, slug }, { limit: 100 }).catch((e) => {
    if (e instanceof AppError && (e.code === "not_found" || e.code === "forbidden")) return null;
    throw e;
  });
  if (!rows) notFound();
  const tz = (await listMyWorkspaces(getPool(), user.id)).find((w) => w.slug === slug)?.timezone ?? "Asia/Jakarta";
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Log audit</h1>
          <p>100 kejadian terakhir. Hanya admin dan pemilik yang dapat melihat; isi perubahan tidak ditampilkan.</p>
        </div>
      </header>
      {rows.length === 0 && <div className="empty"><strong>Belum ada kejadian tercatat.</strong></div>}
      <div className="list">
        {rows.map((r) => {
          const grp = r.action.split(".")[0] ?? "";
          return (
            <div className="list-row" key={r.id}>
              <span className="grow">
                <strong>{ACTION[r.action] ?? r.action}</strong>
                <small>{r.actorName ?? "sistem / tamu"} · {r.createdAt.toLocaleString("id-ID", { timeZone: tz })} {TZ_LABEL[tz] ?? tz}</small>
              </span>
              <span className="badge" title={r.action}>{GROUP[grp] ?? grp}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
