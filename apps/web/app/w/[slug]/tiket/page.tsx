import { AppError, listClients, listMembers, listMyWorkspaces } from "@jadwalin/core";
import { FeatureOff } from "@/components/feature-off";
import { listTickets, type TicketStatus } from "@jadwalin/module-tickets";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createTicketStaffAction } from "@/lib/ticket-actions";
import { PRIORITY_LABEL, STATUS_LABEL, fmtDateTime } from "@/lib/format";
import { getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function TiketListPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ status?: string; assignee?: string; q?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { slug } = await params;
  const sp = await searchParams;
  const actor = { userId: user.id, slug };
  const pool = getPool();
  const mine = (await listMyWorkspaces(pool, user.id)).find((w) => w.slug === slug);
  if (!mine) notFound();
  if (!mine.features.tiket) return <FeatureOff feature="tiket" slug={slug} canManage={mine.role !== "staff"} />;

  const status = sp.status === "semua" ? undefined : sp.status && sp.status in STATUS_LABEL ? [sp.status as TicketStatus] : ("aktif" as const);
  const tickets = await listTickets(pool, actor, { status, assignee: sp.assignee || undefined, q: sp.q }).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") return null;
    throw e;
  });
  if (!tickets) notFound();
  const [clients, members] = await Promise.all([listClients(pool, actor), listMembers(pool, actor)]);

  const cur = sp.status && (sp.status === "semua" || sp.status in STATUS_LABEL) ? sp.status : "aktif";
  const qs = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string> = { status: cur, assignee: sp.assignee ?? "", q: sp.q ?? "", ...over };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === "status" && v === "aktif")) p.set(k, v);
    const str = p.toString();
    return `/w/${slug}/tiket${str ? `?${str}` : ""}`;
  };
  const STATUS_TONE: Record<string, string> = { open: "warn", waiting_client: "warn", resolved: "ok" };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Tiket</h1>
          <p>Klien membuka tiket sendiri lewat <strong>jadwalin.id/{slug}</strong>. Anda juga bisa membuatnya atas nama klien.</p>
        </div>
      </header>

      <nav className="chips" aria-label="Filter status">
        <Link href={qs({ status: "aktif" })} className={cur === "aktif" ? "on" : ""}>Aktif</Link>
        {Object.entries(STATUS_LABEL).map(([k, v]) => <Link key={k} href={qs({ status: k })} className={cur === k ? "on" : ""}>{v}</Link>)}
        <Link href={qs({ status: "semua" })} className={cur === "semua" ? "on" : ""}>Semua</Link>
      </nav>

      <form method="get" className="toolbar">
        <input type="hidden" name="status" value={cur} />
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Cari judul tiket…" aria-label="Cari judul tiket" />
        <select name="assignee" defaultValue={sp.assignee ?? ""} aria-label="Penanggung jawab">
          <option value="">Semua penanggung jawab</option>
          <option value="me">Saya</option>
          <option value="none">Belum ditugaskan</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button>Cari</button>
      </form>

      {tickets.length === 0 && (
        <div className="empty"><strong>Tidak ada tiket{cur === "aktif" ? " aktif" : ""}.</strong><small>Tiket baru dari klien akan muncul di sini dan menambah angka di menu.</small></div>
      )}
      <div className="list">
        {tickets.map((t) => (
          <Link className="list-row link-row" key={t.number} href={`/w/${slug}/tiket/${t.number}`}>
            <span className="tk-num">#{t.number}</span>
            <span className="grow">
              <strong>{t.title}</strong>
              <small>{t.clientName ?? "—"} · {t.assigneeName ? `ditangani ${t.assigneeName}` : "belum ditugaskan"} · {fmtDateTime(t.lastActivityAt, "Asia/Jakarta")}</small>
            </span>
            <span className="stack-end">
              <span className={`badge ${STATUS_TONE[t.status] ?? ""}`}>{STATUS_LABEL[t.status]}</span>
              <small>{PRIORITY_LABEL[t.priority]}</small>
            </span>
          </Link>
        ))}
      </div>

      <details className="fold" id="buat" open={Boolean(sp.error)}>
        <summary>+ Buat tiket atas nama klien</summary>
        {clients.length === 0 ? (
          <small>Belum ada klien. Klien muncul otomatis setelah membuka tiket sendiri.</small>
        ) : (
          <form action={createTicketStaffAction.bind(null, slug)}>
            <div className="two">
              <label>Klien<select name="clientId" required>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.email ? ` (${c.email})` : ""}</option>)}</select></label>
              <label>Penanggung jawab<select name="assignee"><option value="">Belum ditugaskan</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
            </div>
            <label>Judul<input name="title" required minLength={3} maxLength={200} /></label>
            <label>Deskripsi<textarea name="description" rows={4} maxLength={10000} /></label>
            <label>Prioritas<select name="priority" defaultValue="normal">{Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            {sp.error && <p className="error" role="alert">{sp.error}</p>}
            <button>Buat tiket</button>
          </form>
        )}
      </details>
    </>
  );
}
