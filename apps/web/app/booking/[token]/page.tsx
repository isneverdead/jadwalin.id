import { getBookingByToken, getBookingPayment } from "@jadwalin/core";
import Link from "next/link";
import { cancelBookingAction } from "@/lib/booking-actions";
import { fmtDateTime } from "@/lib/format";
import { getPool } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Halaman kelola booking untuk pemegang tautan (dari email): lihat, ubah jadwal, atau batalkan. Tanpa login. */
export default async function ManageBookingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string; baru?: string; diubah?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const b = await getBookingByToken(getPool(), token);
  const payment = b ? await getBookingPayment(getPool(), token) : null;
  const awaiting = !!payment && payment.status === "pending" && b?.status === "pending";

  if (!b) {
    return (
      <>
        <h1>Booking tidak ditemukan</h1>
        <p>Tautan ini tidak valid. Periksa kembali tautan di email konfirmasi Anda.</p>
      </>
    );
  }

  const tz = b.workspace.timezone;
  const cancelled = b.status === "cancelled";
  return (
    <>
      <h1>{cancelled ? "Booking dibatalkan" : awaiting ? "Menunggu pembayaran" : sp.baru ? "Booking terkonfirmasi" : "Booking Anda"}</h1>
      {awaiting && payment && (
        <div className="card" style={{ display: "block" }}>
          <p>Selesaikan pembayaran <strong>Rp{payment.amountIdr.toLocaleString("id-ID")}</strong> sebelum {fmtDateTime(payment.expiresAt, tz)} agar slot Anda tidak dilepas.</p>
          {payment.checkoutUrl && <p><a href={payment.checkoutUrl}><button>Bayar sekarang</button></a></p>}
        </div>
      )}
      {payment?.status === "paid" && <p className="badge">Pembayaran diterima</p>}
      {payment?.status === "expired" && <p className="error">Waktu pembayaran habis dan slot dilepas. Silakan pesan ulang.</p>}
      {sp.baru && !awaiting && <p>Terima kasih! Kami sudah mengirim konfirmasi dan pengingat ke email Anda. Simpan halaman ini untuk mengubah atau membatalkan jadwal.</p>}
      {sp.diubah && <p>Jadwal Anda sudah diperbarui.</p>}
      {sp.error && <p className="error" role="alert">{sp.error}</p>}

      <div className="card" style={{ display: "block" }}>
        <strong>{b.type.title}</strong> dengan {b.workspace.name}<br />
        <span>{fmtDateTime(b.startsAt, tz)}</span> <small>({b.type.durationMin} menit)</small>
        {b.canChange && b.type.locationValue && (
          <><br /><small>{b.type.locationKind === "link" ? <a href={b.type.locationValue}>{b.type.locationValue}</a> : `${b.type.locationKind === "phone" ? "Telepon" : "Lokasi"}: ${b.type.locationValue}`}</small></>
        )}
      </div>

      {b.canChange ? (
        <>
          <p><Link href={`/booking/${token}/ubah`}><button>Ubah jadwal</button></Link></p>
          <form action={cancelBookingAction.bind(null, token)}><button className="link">Batalkan booking</button></form>
        </>
      ) : (
        <p><small>{cancelled ? "Booking ini sudah dibatalkan." : "Booking ini sudah tidak bisa diubah."}</small></p>
      )}
      <p><small><Link href={`/${b.workspace.slug}`}>Pesan jadwal baru</Link></small></p>
    </>
  );
}
