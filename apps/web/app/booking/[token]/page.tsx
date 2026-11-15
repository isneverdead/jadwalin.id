import { bookingCode, getBookingByToken, getBookingChangeView, getBookingPayment, getManualPaymentView, googleCalendarUrl, type BookingRequestView } from "@jadwalin/core";
import Link from "next/link";
import { ConfirmButton } from "@/components/confirm-button";
import { cancelBookingAction } from "@/lib/booking-actions";
import { ackRefundAction, requestCancelAction, withdrawRequestAction } from "@/lib/change-actions";
import { BookingShare } from "@/components/booking-share";
import { ContactHost } from "@/components/contact-host";
import { fmtDateTime } from "@/lib/format";
import { CopyButton } from "@/components/copy-button";
import { ProofUploader } from "@/components/proof-uploader";
import { fmtIdr } from "@/lib/format";
import { getPool, getStorage } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Halaman kelola booking untuk pemegang tautan (dari email): lihat, ubah jadwal, atau batalkan. Tanpa login. */
export default async function ManageBookingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string; baru?: string; diubah?: string; diajukan?: string; pulih?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const b = await getBookingByToken(getPool(), token);
  const payment = b ? await getBookingPayment(getPool(), token) : null;
  const manual = b ? await getManualPaymentView(getPool(), getStorage(), token) : null;
  const awaiting = !manual && !!payment && payment.status === "pending" && b?.status === "pending";
  const manualDue = manual?.payment.status === "pending" && b?.status === "pending";
  const manualWait = manual?.payment.status === "awaiting_verification";
  const change = b ? await getBookingChangeView(getPool(), getStorage(), token) : null;
  const req = change?.request ?? null;
  const reqOpen = req?.status === "requested" || req?.status === "approved";

  if (!b) {
    return (
      <>
        <h1>Booking tidak ditemukan</h1>
        <p>Tautan ini tidak valid atau sudah diganti. Periksa tautan yang Anda simpan, atau <Link href="/booking/cari">pulihkan dengan kode booking dan nomor HP</Link>.</p>
      </>
    );
  }

  const tz = b.workspace.timezone;
  const cancelled = b.status === "cancelled";
  const refundDone = cancelled && req?.kind === "cancel" && req.status === "completed";
  const code = bookingCode(b.id);
  const when = fmtDateTime(b.startsAt, tz);
  // Konteks yang dibawa ke WhatsApp penyedia: apa yang sudah dilakukan pelanggan di halaman ini.
  const contactLines = (): string[] => {
    const out = [`Saya ${b.clientName}. Booking: ${b.type.title}, ${when} (kode ${code}).`];
    const rupiah = (n: number) => fmtIdr(n);
    if (req?.kind === "cancel" && req.status === "requested") out.push(`Saya mengajukan pembatalan${req.reason ? ` (alasan: ${req.reason})` : ""} dan menunggu persetujuan.`);
    else if (req?.kind === "cancel" && req.status === "approved") out.push(`Pembatalan saya sudah disetujui; saya menunggu pengembalian dana ${rupiah(req.refundAmountIdr ?? 0)}.`);
    else if (req?.kind === "cancel" && req.status === "rejected") out.push("Pengajuan pembatalan saya ditolak.");
    else if (refundDone) out.push((req?.refundAmountIdr ?? 0) > 0 ? `Booking sudah dibatalkan dan dana ${rupiah(req!.refundAmountIdr!)} dikembalikan${req!.customerAck === "received" ? " (sudah saya terima)" : req!.customerAck === "not_received" ? " (BELUM masuk ke rekening saya)" : ""}.` : "Booking sudah dibatalkan.");
    else if (cancelled) out.push("Booking ini sudah dibatalkan.");
    else if (req?.kind === "reschedule" && req.status === "requested") out.push(`Saya meminta ubah jadwal ke ${req.newStartsAt ? fmtDateTime(req.newStartsAt, tz) : "waktu lain"} dan menunggu persetujuan.`);
    else if (req?.kind === "reschedule" && req.status === "rejected") out.push("Permintaan ubah jadwal saya ditolak.");
    else if (manualDue && manual) out.push(`Saya belum membayar DP ${rupiah(manual.payment.amountIdr)}.${manual.proof?.status === "rejected" ? " Bukti sebelumnya ditolak." : ""}`);
    else if (manualWait && manual) out.push(`Saya sudah mengirim bukti pembayaran DP ${rupiah(manual.payment.amountIdr)} dan menunggu verifikasi.`);
    else if (manual?.payment.status === "paid") out.push(`DP ${rupiah(manual.payment.amountIdr)} sudah terkonfirmasi.`);
    else out.push("Booking saya terkonfirmasi.");
    return out;
  };
  return (
    <>
      <h1>{refundDone && (req?.refundAmountIdr ?? 0) > 0 ? "Booking dibatalkan, dana dikembalikan" : cancelled ? "Booking dibatalkan" : req?.kind === "cancel" && req.status === "requested" ? "Pembatalan menunggu persetujuan" : req?.kind === "cancel" && req.status === "approved" ? "Pembatalan disetujui, dana segera dikembalikan" : req?.kind === "reschedule" && req.status === "requested" ? "Ubah jadwal menunggu persetujuan" : manualDue ? "Selesaikan pembayaran" : manualWait ? "Bukti diterima, menunggu verifikasi" : awaiting ? "Menunggu pembayaran" : sp.baru ? "Booking terkonfirmasi" : "Booking Anda"}</h1>
      {awaiting && payment && (
        <div className="card" style={{ display: "block" }}>
          <p>Selesaikan pembayaran <strong>Rp{payment.amountIdr.toLocaleString("id-ID")}</strong> sebelum {fmtDateTime(payment.expiresAt, tz)} agar slot Anda tidak dilepas.</p>
          {payment.checkoutUrl && <p><a href={payment.checkoutUrl}><button>Bayar sekarang</button></a></p>}
        </div>
      )}
      {payment?.status === "paid" && <p className="badge">Pembayaran diterima</p>}
      {payment?.status === "expired" && <p className="error">Waktu pembayaran habis dan slot dilepas. Silakan pesan ulang.</p>}
      {sp.baru && !awaiting && <p>Terima kasih! Booking Anda tercatat. <strong>Simpan tautan halaman ini</strong> (lihat di bawah) untuk mengubah, membatalkan, atau melihat kabar dari penyedia jasa.</p>}
      {sp.pulih && <p className="notice ok">Booking dipulihkan. Tautan halaman ini adalah tautan baru; tautan lama tidak berlaku lagi. Simpan tautan ini.</p>}
      {sp.diajukan && <p className="notice ok">Permintaan Anda terkirim ke penyedia jasa. Buka kembali halaman ini untuk melihat keputusannya.</p>}
      {sp.diubah && <p>Jadwal Anda sudah diperbarui.</p>}
      {sp.error && <p className="error" role="alert">{sp.error}</p>}

      {!cancelled && <BookingShare token={token} code={code} title={b.type.title} ws={b.workspace.name} slug={b.workspace.slug} when={when} />}
      {req && req.kind !== "reschedule" ? <RequestPanel req={req} tz={tz} token={token} /> : req && <ReschedulePanel req={req} tz={tz} token={token} />}

      {manual && !cancelled && (
        <section className="pay-box" aria-label="Pembayaran">
          <ol className="timeline" aria-label="Tahap booking">
            <Step state="done" title="Booking dibuat">{when}</Step>
            <Step state={manualDue ? "now" : "done"} title={manualDue ? `Bayar DP ${fmtIdr(manual.payment.amountIdr)}` : "DP dibayar"}>{manualDue ? `Slot ditahan sampai ${fmtDateTime(manual.payment.expiresAt, tz)}` : undefined}</Step>
            <Step state={manual.payment.status === "paid" ? "done" : manualWait ? "now" : "todo"} title="Bukti diperiksa penyedia">{manualWait ? "Biasanya dalam beberapa jam" : undefined}</Step>
            <Step state={manual.payment.status === "paid" ? "done" : "todo"} title="Booking terkonfirmasi" />
          </ol>
          {manualDue && <p className="pay-amount"><small>Bayar DP tepat sebesar</small><strong>{fmtIdr(manual.payment.amountIdr)}</strong></p>}
          {manual.payment.status === "paid" && <p className="badge">Pembayaran terkonfirmasi</p>}
          {manualWait && <p>Terima kasih. Penyedia jasa sedang memeriksa bukti pembayaran Anda. Slot tetap ditahan untuk Anda; buka kembali halaman ini untuk melihat konfirmasinya.</p>}
          {manualDue && (
            <>
              <p>Bayar <strong>{fmtIdr(manual.payment.amountIdr)}</strong> ke salah satu metode di bawah sebelum <strong>{fmtDateTime(manual.payment.expiresAt, tz)}</strong>, lalu unggah bukti pembayaran.</p>
              <ol className="pay-steps pay-steps-sm" aria-label="Langkah pembayaran">
                <li><span className="pay-step-n" aria-hidden="true">1</span><span>Transfer tepat <b>{fmtIdr(manual.payment.amountIdr)}</b></span></li>
                <li><span className="pay-step-n" aria-hidden="true">2</span><span>Simpan bukti (foto atau PDF)</span></li>
                <li><span className="pay-step-n" aria-hidden="true">3</span><span>Unggah di bawah; statusnya tampil di halaman ini</span></li>
              </ol>
              {manual.proof?.status === "rejected" && <p className="error" role="alert">Bukti sebelumnya ditolak: {manual.proof.rejectReason}. Silakan unggah ulang.</p>}
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
            </>
          )}
        </section>
      )}

      <div className="card" style={{ display: "block" }}>
        <small>Kode booking</small> <code className="booking-code">{code}</code> <CopyButton text={code} /><br />
        <strong>{b.type.title}</strong> dengan {b.workspace.name}<br />
        <span>{when}</span> <small>({b.type.durationMin} menit)</small>
        {b.canChange && b.type.locationValue && (
          <><br /><small>{b.type.locationKind === "link" ? <a href={b.type.locationValue}>{b.type.locationValue}</a> : `${b.type.locationKind === "phone" ? "Telepon" : "Lokasi"}: ${b.type.locationValue}`}</small></>
        )}
      </div>

      {!cancelled && (
        <p className="row-btns">
          <a className="btn btn-ghost" href={`/booking/${token}/kalender`}>Tambah ke kalender (.ics)</a>
          <a className="btn btn-ghost" href={googleCalendarUrl({ title: `${b.type.title} - ${b.workspace.name}`, startsAt: b.startsAt, endsAt: b.endsAt, description: `Kode booking: ${code}` })} target="_blank" rel="noopener">Google Kalender ↗</a>
        </p>
      )}

      {b.canChange ? (
        reqOpen ? (
          <p><small>Perubahan lain tidak bisa dilakukan selama permintaan di atas belum diputuskan.</small></p>
        ) : change && !change.policy.windowOpen ? (
          <p className="notice warn">Perubahan sendiri hanya bisa dilakukan paling lambat {change.policy.changeMinHours} jam sebelum jadwal. Hubungi penyedia jasa bila perlu mengubah atau membatalkan.</p>
        ) : (
          <>
            <p><Link href={`/booking/${token}/ubah`}><button>{change?.policy.rescheduleMode === "approval" ? "Minta ubah jadwal" : "Ubah jadwal"}</button></Link></p>
            {change?.paid ? (
              <details className="fold">
                <summary>Ajukan pembatalan</summary>
                <p>DP <strong>{fmtIdr(change.paid.amountIdr)}</strong> sudah dibayar. Pembatalan harus disetujui penyedia jasa, yang menentukan dan mengirim pengembalian dana. Booking tetap berlaku sampai dana dikembalikan.</p>
                <form action={requestCancelAction.bind(null, token)}>
                  <label>Alasan pembatalan<input name="reason" required minLength={3} maxLength={300} placeholder="Mis. berhalangan hadir" /></label>
                  <label><span>Tujuan pengembalian dana <small>(bank/e-wallet, nomor, atas nama)</small></span><input name="refundAccount" required minLength={5} maxLength={200} placeholder="BCA 1234567890 a.n. Nama Anda" /></label>
                  <button className="danger">Kirim pengajuan pembatalan</button>
                </form>
              </details>
            ) : (
              <form action={cancelBookingAction.bind(null, token)}><ConfirmButton className="link danger-link" message="Batalkan booking ini? Slot akan dilepas.">Batalkan booking</ConfirmButton></form>
            )}
          </>
        )
      ) : (
        <p><small>{cancelled ? "Booking ini sudah dibatalkan." : "Booking ini sudah tidak bisa diubah."}</small></p>
      )}
      <p><small><Link href={`/${b.workspace.slug}`}>Pesan jadwal baru</Link></small></p>
      {b.workspace.contactPhone && <ContactHost phone={b.workspace.contactPhone} ws={b.workspace.name} token={token} lines={contactLines()} />}
    </>
  );
}

function Step({ state, title, children }: { state: "done" | "now" | "todo"; title: string; children?: React.ReactNode }) {
  return (
    <li className={`tl-step ${state}`}>
      <span className="tl-dot" aria-hidden="true">{state === "done" ? "✓" : ""}</span>
      <div><strong>{title}</strong>{children && <small>{children}</small>}</div>
    </li>
  );
}

/** Status pembatalan: diajukan → disetujui → dana dikembalikan (dengan bukti transfer dan konfirmasi pelanggan). */
function RequestPanel({ req, tz, token }: { req: BookingRequestView; tz: string; token: string }) {
  const rejected = req.status === "rejected";
  const approved = req.status === "approved" || req.status === "completed";
  const done = req.status === "completed";
  const refund = req.refundAmountIdr ?? 0;
  return (
    <section className="panel tight" aria-labelledby="req-h">
      <h3 id="req-h">Status pembatalan</h3>
      {rejected ? (
        <>
          <p className="notice warn">Pengajuan pembatalan belum dapat disetujui. {req.decisionNote ? `Alasan: ${req.decisionNote}` : ""} Booking Anda tetap berlaku.</p>
        </>
      ) : (
        <ol className="timeline" aria-label="Langkah pembatalan">
          <Step state="done" title="Pengajuan terkirim">{fmtDateTime(req.createdAt, tz)}{req.reason ? ` · ${req.reason}` : ""}</Step>
          <Step state={approved ? "done" : "now"} title={approved ? "Disetujui penyedia jasa" : "Menunggu persetujuan penyedia jasa"}>
            {approved && req.decidedAt ? `${fmtDateTime(req.decidedAt, tz)}${req.decisionNote ? ` · ${req.decisionNote}` : ""}` : "Booking tetap berlaku sampai disetujui."}
          </Step>
          <Step state={done ? "done" : approved ? "now" : "todo"} title={done ? (refund > 0 ? `Dana ${fmtIdr(refund)} dikembalikan` : "Dibatalkan tanpa pengembalian dana") : refund > 0 ? `Menunggu pengembalian dana ${fmtIdr(refund)}` : "Pengembalian dana"}>
            {done && req.refundedAt ? fmtDateTime(req.refundedAt, tz) : approved && refund > 0 ? "Penyedia jasa mentransfer ke rekening yang Anda isi lalu mengunggah buktinya di sini." : undefined}
          </Step>
        </ol>
      )}
      {done && refund > 0 && (
        <div className="refund-proof">
          {req.refundProofUrl ? (
            <p><a className="btn btn-ghost" href={req.refundProofUrl} target="_blank" rel="noopener">Lihat bukti transfer refund ↗</a></p>
          ) : null}
          {req.customerAck === "received" ? <p className="badge ok">Anda sudah mengonfirmasi dana diterima</p> : req.customerAck === "not_received" ? <p className="notice warn">Anda melaporkan dana belum masuk. Penyedia jasa sudah diberi tahu.</p> : (
            <div>
              <p>Sudah menerima dananya?</p>
              <div className="row-btns">
                <form action={ackRefundAction.bind(null, token, "received")}><button>Ya, dana sudah diterima</button></form>
                <form action={ackRefundAction.bind(null, token, "not_received")}><button className="btn-ghost">Belum masuk</button></form>
              </div>
            </div>
          )}
        </div>
      )}
      {req.status === "requested" && <form action={withdrawRequestAction.bind(null, token)}><button className="link">Tarik pengajuan</button></form>}
    </section>
  );
}

function ReschedulePanel({ req, tz, token }: { req: BookingRequestView; tz: string; token: string }) {
  if (req.status === "rejected") return <section className="panel tight"><h3>Permintaan ubah jadwal</h3><p className="notice warn">Permintaan ubah jadwal belum dapat disetujui. {req.decisionNote ? `Alasan: ${req.decisionNote}` : ""} Jadwal lama tetap berlaku.</p></section>;
  if (req.status !== "requested") return null;
  return (
    <section className="panel tight" aria-labelledby="rs-h">
      <h3 id="rs-h">Permintaan ubah jadwal</h3>
      <p>Anda meminta pindah ke <strong>{req.newStartsAt ? fmtDateTime(req.newStartsAt, tz) : "—"}</strong>. Jadwal lama tetap berlaku sampai penyedia jasa menyetujui.</p>
      <form action={withdrawRequestAction.bind(null, token)}><button className="link">Tarik permintaan</button></form>
    </section>
  );
}
