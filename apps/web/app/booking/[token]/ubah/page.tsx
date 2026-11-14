import { getBookingByToken, getBookingChangeView, listRescheduleSlots } from "@jadwalin/core";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { rescheduleBookingAction } from "@/lib/booking-actions";
import { requestRescheduleAction } from "@/lib/change-actions";
import { SlotPicker } from "@/components/slot-picker";
import { fmtDateTime, toPickerDays, tzLabel } from "@/lib/format";
import { getPool, getStorage } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function RescheduleBookingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await params;
  const { error } = await searchParams;
  const pool = getPool();
  const b = await getBookingByToken(pool, token);
  if (!b) notFound();
  if (!b.canChange) redirect(`/booking/${token}`);
  const change = await getBookingChangeView(pool, getStorage(), token);
  if (change?.request && (change.request.status === "requested" || change.request.status === "approved")) redirect(`/booking/${token}`);
  const approval = change?.policy.rescheduleMode === "approval";
  const slots = (await listRescheduleSlots(pool, token)) ?? [];
  const tz = b.workspace.timezone;
  const { days, todayKey } = toPickerDays(slots.filter((s) => s.start.getTime() <= Date.now() + 28 * 86_400_000), tz);

  return (
    <>
      <p><Link href={`/booking/${token}`}>← Kembali</Link></p>
      <h1>{approval ? "Minta ubah jadwal" : "Ubah jadwal"}</h1>
      {change && !change.policy.windowOpen && <p className="notice warn">Perubahan sendiri hanya bisa dilakukan paling lambat {change.policy.changeMinHours} jam sebelum jadwal. Hubungi penyedia jasa.</p>}
      {approval && <p>Usaha ini meminta persetujuan untuk perubahan jadwal. Jadwal lama tetap berlaku sampai penyedia jasa menyetujui permintaan Anda.</p>}
      <p>Saat ini: <strong>{fmtDateTime(b.startsAt, tz)}</strong> · jam dalam {tzLabel(tz)}</p>
      {days.length === 0 ? (
        <p>Tidak ada jadwal kosong lain dalam 4 minggu ke depan.</p>
      ) : (
        <form action={(approval ? requestRescheduleAction : rescheduleBookingAction).bind(null, token)}>
          <SlotPicker days={days} todayKey={todayKey} tzName={tzLabel(tz)} />
          {approval && <label><span>Alasan <small>(opsional)</small></span><input name="note" maxLength={300} placeholder="Mis. ada keperluan mendadak" /></label>}
          {error && <p className="error" role="alert">{error}</p>}
          <button className="cta">{approval ? "Kirim permintaan ubah jadwal" : "Simpan jadwal baru"}</button>
        </form>
      )}
    </>
  );
}
