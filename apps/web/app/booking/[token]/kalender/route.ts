import { bookingCode, buildIcs, getBookingByToken } from "@jadwalin/core";
import { getPool } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Unduh .ics booking untuk pemegang tautan (token = kredensial). Token salah → 404 tanpa petunjuk. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const b = await getBookingByToken(getPool(), token);
  if (!b || b.status === "cancelled") return new Response("Tidak ditemukan", { status: 404 });
  const code = bookingCode(b.id);
  const loc = b.type.locationKind === "in_person" ? undefined : b.type.locationValue ?? undefined; // teks lokasi tatap muka bebas: tidak dibawa ke berkas
  const ics = buildIcs({
    uid: b.id,
    title: `${b.type.title} - ${b.workspace.name}`,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    description: `Kode booking: ${code}`,
    location: loc,
    now: new Date(),
  });
  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="booking-${code}.ics"`,
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
    },
  });
}
