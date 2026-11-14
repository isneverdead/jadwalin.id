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

  const features = "features" in mine ? mine.features : undefined;
  return (
    <>
      <p className="crumb"><Link href="/jadwal-saya">← Jadwal saya</Link></p>
      <header className="page-head"><div><h1>{mine.workspaceName}</h1></div><Link className="btn btn-ghost" href={`/${slug}`}>Pesan jadwal →</Link></header>

      {features && !features.tiket ? (
        <div className="empty"><strong>Halaman ini tidak menerima pesan lewat tiket.</strong><small>Untuk membuat janji, pesan jadwal lewat halaman booking mereka.</small></div>
      ) : (
        <>
          <section className="panel">
            <div className="panel-head"><h2>Tiket Anda</h2></div>
            {mine.tickets.length === 0 && <div className="empty"><strong>Belum ada tiket.</strong><small>Kirim pesan pertama Anda di bawah.</small></div>}
            <div className="list">
              {mine.tickets.map((t) => (
                <Link className="list-row link-row" key={t.number} href={`/jadwal-saya/${slug}/tiket/${t.number}`}>
                  <span className="tk-num">#{t.number}</span>
                  <span className="grow"><strong>{t.title}</strong><small>Diperbarui {fmtDateTime(t.lastActivityAt, mine.timezone)}</small></span>
                  <span className="badge">{STATUS_LABEL[t.status]}</span>
                </Link>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Kirim pesan baru</h2></div>
            {mine.blocked ? (
              <p className="error">Akun Anda tidak dapat mengirim pesan baru ke halaman ini.</p>
            ) : (
              <form action={createClientTicketAction.bind(null, slug)}>
                <label>Judul / topik<input name="title" required minLength={3} maxLength={200} placeholder="Mis. Butuh konsultasi SPT" /></label>
                <label>Ceritakan kebutuhan Anda<textarea name="description" rows={5} maxLength={10000} /></label>
                {error && <p className="error" role="alert">{error}</p>}
                <button>Kirim</button>
              </form>
            )}
          </section>
        </>
      )}
    </>
  );
}
