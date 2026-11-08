import { listPublicSlots } from "@jadwalin/core";
import { loadTurnstileEnv } from "@jadwalin/config";
import { listMyTickets } from "@jadwalin/module-tickets";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Turnstile } from "@/components/turnstile";
import { bookAction } from "@/lib/booking-actions";
import { groupSlotsByDay, tzLabel } from "@/lib/format";
import { currentUser, getPool } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function BookPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; type: string }>;
  searchParams: Promise<{ error?: string; hari?: string }>;
}) {
  const { slug, type } = await params;
  const { error, hari } = await searchParams;
  const pool = getPool();
  const data = await listPublicSlots(pool, slug, type);
  if (!data) notFound();
  const { workspace, type: mt } = data;
  const tz = workspace.timezone;

  const days = Math.min(Math.max(Number(hari) || 14, 1), mt.maxDaysAhead);
  const horizon = Date.now() + days * 86_400_000;
  const visible = data.slots.filter((s) => s.start.getTime() <= horizon);
  const groups = groupSlotsByDay(visible, tz);
  const more = data.slots.some((s) => s.start.getTime() > horizon);

  const user = await currentUser();
  const myTickets = user
    ? (await listMyTickets(pool, user.id, slug).catch(() => null))?.tickets.filter((t) => t.status !== "closed") ?? []
    : [];
  const turnstile = loadTurnstileEnv();
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <>
      <p><Link href={`/${workspace.slug}`}>← {workspace.name}</Link></p>
      <h1>{mt.title}</h1>
      <p><small>{mt.durationMin} menit · jam dalam {tzLabel(tz)}</small></p>

      {groups.length === 0 ? (
        <p>Belum ada jadwal kosong dalam {days} hari ke depan. {more ? "" : "Coba lagi nanti atau kirim pesan ke kami."}</p>
      ) : (
        <form action={bookAction.bind(null, workspace.slug, mt.slug)}>
          <label>Pilih waktu
            <select name="startsAt" required defaultValue="">
              <option value="" disabled>Pilih tanggal dan jam…</option>
              {groups.map((g) => (
                <optgroup key={g.day} label={g.day}>
                  {g.items.map((i) => <option key={i.iso} value={i.iso}>{i.label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>

          {user ? (
            <>
              <p><small>Memesan sebagai <strong>{user.name}</strong> ({user.email}).</small></p>
              {myTickets.length > 0 && (
                <label>Kaitkan dengan tiket
                  <select name="ticket" defaultValue="">
                    <option value="">Buat tiket baru</option>
                    {myTickets.map((t) => <option key={t.number} value={t.number}>#{t.number} {t.title}</option>)}
                  </select>
                </label>
              )}
              <label>Topik<input name="topic" maxLength={200} placeholder="Apa yang ingin dibahas?" /></label>
            </>
          ) : (
            <>
              <label>Nama<input name="name" required minLength={2} maxLength={100} autoComplete="name" /></label>
              <label>Email (untuk konfirmasi dan pengingat)<input name="email" type="email" required autoComplete="email" /></label>
              <label>Nomor HP (opsional)<input name="phone" type="tel" autoComplete="tel" placeholder="0812…" /></label>
              <label>Topik<input name="topic" required minLength={3} maxLength={200} placeholder="Apa yang ingin dibahas?" /></label>
            </>
          )}
          <label>Catatan (opsional)<textarea name="notes" rows={3} maxLength={2000} /></label>

          {/* Honeypot: manusia tidak melihatnya; bot biasanya mengisinya. */}
          <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", height: 0, overflow: "hidden" }}>
            <label>Situs web<input name="website" tabIndex={-1} autoComplete="off" /></label>
          </div>

          {!user && (
            <label className="check"><input type="checkbox" name="privacy" required /> Saya telah membaca <a href="/privasi" target="_blank" rel="noopener">pemberitahuan privasi</a>; data saya diproses oleh {workspace.name} dan jadwalin.id untuk keperluan booking ini.</label>
          )}
          {!user && turnstile.siteKey && <Turnstile siteKey={turnstile.siteKey} nonce={nonce} />}
          {error && <p className="error" role="alert">{error}</p>}
          <button>Pesan jadwal</button>
          {!user && <small>Tanpa akun: kami kirim tautan kelola (batal/ubah jadwal) ke email Anda.</small>}
        </form>
      )}
      {more && <p><Link href={`/${workspace.slug}/${mt.slug}?hari=${days + 14}`}>Tampilkan lebih banyak hari</Link></p>}
    </>
  );
}
