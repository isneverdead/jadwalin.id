import { AppError, getPublicWorkspace } from "@jadwalin/core";
import { listMyTickets } from "@jadwalin/module-tickets";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClientTicketAction } from "@/lib/ticket-actions";
import { STATUS_LABEL, fmtDateTime } from "@/lib/format";
import { getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function ClientPortalPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const { error } = await searchParams;
  const pool = getPool();

  // Pengguna yang belum pernah menghubungi workspace ini belum punya catatan klien: tampilkan formulir kosong.
  const mine = await listMyTickets(pool, user.id, slug).catch(async (e) => {
    if (!(e instanceof AppError && e.code === "not_found")) throw e;
    const ws = await getPublicWorkspace(pool, slug, user.id);
    return ws ? { workspaceName: ws.name, timezone: ws.timezone, blocked: false, tickets: [] } : null;
  });
  if (!mine) notFound();

  return (
    <>
      <p><Link href="/jadwal-saya">← Jadwal saya</Link></p>
      <h1>{mine.workspaceName}</h1>

      <h2>Tiket Anda</h2>
      {mine.tickets.length === 0 && <p><small>Belum ada tiket.</small></p>}
      {mine.tickets.map((t) => (
        <div className="card" key={t.number}>
          <span><Link href={`/jadwal-saya/${slug}/tiket/${t.number}`}>#{t.number} {t.title}</Link><br /><small>Diperbarui {fmtDateTime(t.lastActivityAt, mine.timezone)}</small></span>
          <small>{STATUS_LABEL[t.status]}</small>
        </div>
      ))}

      <h2>Kirim pesan baru</h2>
      {mine.blocked ? (
        <p className="error">Akun Anda tidak dapat mengirim pesan baru ke workspace ini.</p>
      ) : (
        <form action={createClientTicketAction.bind(null, slug)}>
          <label>Judul / topik<input name="title" required minLength={3} maxLength={200} placeholder="Mis. Butuh konsultasi SPT" /></label>
          <label>Ceritakan kebutuhan Anda<textarea name="description" rows={5} maxLength={10000} /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button>Kirim</button>
        </form>
      )}
    </>
  );
}
