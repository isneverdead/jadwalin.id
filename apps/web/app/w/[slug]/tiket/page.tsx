import { AppError, listClients, listMembers } from "@jadwalin/core";
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

  const status = sp.status === "semua" ? undefined : sp.status && sp.status in STATUS_LABEL ? [sp.status as TicketStatus] : ("aktif" as const);
  const tickets = await listTickets(pool, actor, { status, assignee: sp.assignee || undefined, q: sp.q }).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") return null;
    throw e;
  });
  if (!tickets) notFound();
  const [clients, members] = await Promise.all([listClients(pool, actor), listMembers(pool, actor)]);

  return (
    <>
      <p><Link href={`/w/${slug}`}>← Workspace</Link></p>
      <h1>Tiket</h1>
      <p><small>Klien membuka tiket sendiri lewat <strong>jadwalin.id/{slug}</strong>. Anda juga bisa membuatnya atas nama klien di bawah.</small></p>

      <form method="get" style={{ gridTemplateColumns: "1fr 1fr", display: "grid" }}>
        <label>Status
          <select name="status" defaultValue={sp.status ?? "aktif"}>
            <option value="aktif">Aktif (belum ditutup)</option>
            <option value="semua">Semua</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Penanggung jawab
          <select name="assignee" defaultValue={sp.assignee ?? ""}>
            <option value="">Semua</option>
            <option value="me">Saya</option>
            <option value="none">Belum ditugaskan</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label style={{ gridColumn: "1 / -1" }}>Cari judul<input name="q" defaultValue={sp.q ?? ""} /></label>
        <button style={{ gridColumn: "1 / -1" }}>Terapkan</button>
      </form>

      {tickets.length === 0 && <p>Tidak ada tiket.</p>}
      {tickets.map((t) => (
        <div className="card" key={t.number} style={{ alignItems: "flex-start" }}>
          <span>
            <Link href={`/w/${slug}/tiket/${t.number}`}>#{t.number} {t.title}</Link><br />
            <small>{t.clientName ?? "—"} · {t.assigneeName ? `ditangani ${t.assigneeName}` : "belum ditugaskan"} · {fmtDateTime(t.lastActivityAt, "Asia/Jakarta")}</small>
          </span>
          <small style={{ textAlign: "right" }}>{STATUS_LABEL[t.status]}<br />{PRIORITY_LABEL[t.priority]}</small>
        </div>
      ))}

      <h2>Buat tiket untuk klien</h2>
      {clients.length === 0 ? (
        <p><small>Belum ada klien. Klien muncul otomatis setelah membuka tiket sendiri.</small></p>
      ) : (
        <form action={createTicketStaffAction.bind(null, slug)}>
          <label>Klien<select name="clientId" required>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.email ? ` (${c.email})` : ""}</option>)}</select></label>
          <label>Judul<input name="title" required minLength={3} maxLength={200} /></label>
          <label>Deskripsi<textarea name="description" rows={4} maxLength={10000} /></label>
          <label>Prioritas<select name="priority" defaultValue="normal">{Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Penanggung jawab<select name="assignee"><option value="">Belum ditugaskan</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          {sp.error && <p className="error" role="alert">{sp.error}</p>}
          <button>Buat tiket</button>
        </form>
      )}
    </>
  );
}
