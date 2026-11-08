import { getBookingByToken, listRescheduleSlots } from "@jadwalin/core";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { rescheduleBookingAction } from "@/lib/booking-actions";
import { fmtDateTime, groupSlotsByDay, tzLabel } from "@/lib/format";
import { getPool } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function RescheduleBookingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await params;
  const { error } = await searchParams;
  const pool = getPool();
  const b = await getBookingByToken(pool, token);
  if (!b) notFound();
  if (!b.canChange) redirect(`/booking/${token}`);
  const slots = (await listRescheduleSlots(pool, token)) ?? [];
  const tz = b.workspace.timezone;
  const groups = groupSlotsByDay(slots.filter((s) => s.start.getTime() <= Date.now() + 28 * 86_400_000), tz);

  return (
    <>
      <p><Link href={`/booking/${token}`}>← Kembali</Link></p>
      <h1>Ubah jadwal</h1>
      <p>Saat ini: <strong>{fmtDateTime(b.startsAt, tz)}</strong> · jam dalam {tzLabel(tz)}</p>
      {groups.length === 0 ? (
        <p>Tidak ada jadwal kosong lain dalam 4 minggu ke depan.</p>
      ) : (
        <form action={rescheduleBookingAction.bind(null, token)}>
          <label>Waktu baru
            <select name="startsAt" required defaultValue="">
              <option value="" disabled>Pilih tanggal dan jam…</option>
              {groups.map((g) => <optgroup key={g.day} label={g.day}>{g.items.map((i) => <option key={i.iso} value={i.iso}>{i.label}</option>)}</optgroup>)}
            </select>
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button>Simpan jadwal baru</button>
        </form>
      )}
    </>
  );
}
