import { AppError, bookingWhatsAppLink, listAvailableSlots, listMeetingTypes, listMembers } from "@jadwalin/core";
import { getTicket, canTransition, TICKET_STATUSES, type TicketStatus } from "@jadwalin/module-tickets";
import Link from "next/link";
import { Suspense } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { notFound } from "next/navigation";
import { AttachmentUploader } from "@/components/attachment-uploader";
import { PRIORITY_LABEL, STATUS_LABEL, describeEvent, fmtDateTime, fmtSize } from "@/lib/format";
import { appBaseUrl, getPool, myWorkspaces, requireUser } from "@/lib/server";
import {
  assignAction,
  cancelMeetingAction,
  confirmStaffAttachmentAction,
  requestStaffAttachmentAction,
  scheduleMeetingAction,
  setPriorityAction,
  setStatusAction,
  staffCommentAction,
} from "@/lib/ticket-actions";
import { FeatureOff } from "@/components/feature-off";

export const dynamic = "force-dynamic";

type Pool = ReturnType<typeof getPool>;

/** Slot dihitung di luar jalur kritis: bagian lain halaman tampil dulu, form jadwal menyusul (Suspense). */
async function ScheduleForm({ pool, actor, slug, number, slotType, tz }: { pool: Pool; actor: { userId: string; slug: string }; slug: string; number: number; slotType: { id: string; title: string }; tz: string }) {
  const slots = (await listAvailableSlots(pool, actor, { meetingTypeId: slotType.id }).catch(() => [])).slice(0, 40);
  if (slots.length === 0) {
    return <small>Tidak ada slot kosong di kalender Anda. Atur jam kerja di <Link href={`/w/${slug}/jadwal`}>Jadwal &amp; layanan</Link>.</small>;
  }
  return (
    <form action={scheduleMeetingAction.bind(null, slug, number)} className="tk-form">
      <input type="hidden" name="meetingTypeId" value={slotType.id} />
      <label>Jadwalkan “{slotType.title}” (kalender Anda)
        <select name="startsAt" required>{slots.map((s) => <option key={s.start.toISOString()} value={s.start.toISOString()}>{fmtDateTime(s.start, tz)}</option>)}</select>
      </label>
      <button>Jadwalkan &amp; beri tahu klien</button>
    </form>
  );
}

export default async function TiketDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; number: string }>;
  searchParams: Promise<{ error?: string; type?: string }>;
}) {
  const user = await requireUser();
  const { slug, number: numStr } = await params;
  const { error, type } = await searchParams;
  const number = Number(numStr);
  const actor = { userId: user.id, slug };
  const pool = getPool();

  // Semua pembacaan berjalan paralel; daftar halaman memakai cache per permintaan bersama layout.
  const [d, workspaces, members, types] = await Promise.all([
    getTicket(pool, actor, number).catch((e) => {
      if (e instanceof AppError && e.code === "not_found") return null;
      throw e;
    }),
    myWorkspaces(user.id),
    listMembers(pool, actor).catch(() => []),
    listMeetingTypes(pool, actor).catch(() => []),
  ]);
  if (!d) notFound();
  const { ticket, client } = d;
  const mine = workspaces.find((w) => w.slug === slug)!;
  if (!mine.features.tiket) return <FeatureOff feature="tiket" slug={slug} canManage={mine.role !== "staff"} />;
  const tz = mine.timezone;
  const activeTypes = types.filter((t) => t.active);
  const slotType = activeTypes.find((t) => t.id === type) ?? activeTypes[0];
  const nextStatuses = TICKET_STATUSES.filter((s) => canTransition(ticket.status, s as TicketStatus, "staff"));
  const closed = ticket.status === "closed";

  // Garis waktu gabungan: komentar dan riwayat, urut waktu.
  const timeline = [
    ...d.comments.map((c) => ({ at: c.createdAt, kind: "comment" as const, c })),
    ...d.events.map((e) => ({ at: e.createdAt, kind: "event" as const, e })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const TONE: Record<string, string> = { open: "warn", waiting_client: "warn", resolved: "ok" };
  return (
    <>
      <p className="crumb"><Link href={`/w/${slug}/tiket`}>← Semua tiket</Link></p>
      <header className="page-head tk-head">
        <div>
          <h1><span className="tk-hnum">#{ticket.number}</span> {ticket.title}</h1>
          <ul className="tk-meta">
            <li><span className={`badge ${TONE[ticket.status] ?? ""}`}>{STATUS_LABEL[ticket.status]}</span></li>
            <li><small>Prioritas</small> {PRIORITY_LABEL[ticket.priority]}</li>
            <li><small>Klien</small> {client?.name ?? "—"}{client?.email ? <span className="tk-sub"> {client.email}</span> : null}</li>
            <li><small>{d.assignee ? "Ditangani" : "Penanggung jawab"}</small> {d.assignee ? d.assignee.name : "belum ditugaskan"}</li>
          </ul>
        </div>
      </header>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="split tk-split">
        <div className="split-main tk-main">
          {ticket.description && (
            <section className="tk-desc">
              <h2 className="tk-h">Deskripsi</h2>
              <div>{ticket.description}</div>
            </section>
          )}

          <section>
            <h2 className="tk-h">Percakapan &amp; riwayat</h2>
            <div className="thread tk-thread">
              {timeline.map((item) =>
                item.kind === "comment" ? (
                  <div className={`bubble ${item.c.authorKind === "client" ? "from-client" : "from-team"}${item.c.internal ? " internal" : ""}`} key={item.c.id}>
                    <small>{item.c.authorName ?? "—"} · {item.c.authorKind === "client" ? "klien" : "tim"}{item.c.internal ? " · CATATAN INTERNAL (tidak terlihat klien)" : ""} · {fmtDateTime(item.c.createdAt, tz)}</small>
                    <div>{item.c.body}</div>
                  </div>
                ) : (
                  <p className="event tk-event" key={item.e.id}><small>{describeEvent(item.e, item.e.actorName ?? "Seseorang")} · {fmtDateTime(item.e.createdAt, tz)}</small></p>
                ),
              )}
            </div>
          </section>

          {!closed && (
            <form action={staffCommentAction.bind(null, slug, number)} className="reply tk-reply">
              <label>Balas<textarea name="body" rows={4} required maxLength={10000} placeholder="Tulis balasan untuk klien…" /></label>
              <div className="tk-reply-foot">
                <label className="check-row"><input name="internal" type="checkbox" /> Catatan internal (jangan kirim ke klien)</label>
                <button>Kirim</button>
              </div>
            </form>
          )}
        </div>

        <aside className="split-side tk-side">
          {!closed && (
            <section className="panel tight">
              <h3>Kelola tiket</h3>
              <form action={setStatusAction.bind(null, slug, number)} className="inline-form">
                <select name="status" aria-label="Status">{nextStatuses.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
                <button>Ubah status</button>
              </form>
              <form action={setPriorityAction.bind(null, slug, number)} className="inline-form">
                <select name="priority" defaultValue={ticket.priority} aria-label="Prioritas">{Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <button>Ubah prioritas</button>
              </form>
              <form action={assignAction.bind(null, slug, number)} className="inline-form">
                <select name="assignee" defaultValue={ticket.assigneeMemberId ?? ""} aria-label="Penanggung jawab"><option value="">Belum ditugaskan</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
                <button>Tugaskan</button>
              </form>
            </section>
          )}

          <section className="panel tight">
            <h3>Lampiran</h3>
            {d.attachments.length === 0 && <small>Belum ada lampiran.</small>}
            <div className="list">
              {d.attachments.map((a) => (
                <div className="list-row" key={a.id}>
                  <span className="grow">
                    <a href={`/w/${slug}/tiket/${number}/lampiran/${a.id}`}>{a.filename}</a>
                    <small>{fmtSize(a.sizeBytes)} · {a.uploadedByName ?? "—"}{a.clientVisible ? "" : " · tersembunyi dari klien"}</small>
                    {a.contextNote && <small>Konteks: {a.contextNote}</small>}
                  </span>
                </div>
              ))}
            </div>
            {!closed && (
              <div className="tk-upload">
                <AttachmentUploader
                  allowHidden
                  request={requestStaffAttachmentAction.bind(null, slug, number)}
                  confirm={confirmStaffAttachmentAction.bind(null, slug, number)}
                />
              </div>
            )}
          </section>

          <section className="panel tight">
            <h3>Meeting</h3>
            {d.meetings.length === 0 && <small>Belum ada meeting.</small>}
            <div className="list">
              {d.meetings.map((m) => (
                <div className="list-row" key={m.bookingId}>
                  <span className="grow">
                    <strong>{m.title}</strong>
                    <small>{fmtDateTime(m.startsAt, tz)} · {m.status === "cancelled" ? "dibatalkan" : "terjadwal"} · {m.memberName ?? "—"}</small>
                    {m.locationValue && <small>{m.locationKind === "link" ? <a href={m.locationValue}>{m.locationValue}</a> : m.locationValue}</small>}
                  </span>
                  {m.status !== "cancelled" && client?.phone && <a className="btn btn-ghost btn-sm" target="_blank" rel="noopener" href={bookingWhatsAppLink({ phone: client.phone, clientName: client.name, wsName: mine.name, wsSlug: slug, typeTitle: m.title, startsAt: m.startsAt, timezone: tz, bookingId: m.bookingId, baseUrl: appBaseUrl() })}>Kirim tautan lewat WhatsApp ↗</a>}
                  {m.status !== "cancelled" && !closed && <form action={cancelMeetingAction.bind(null, slug, number, m.bookingId)}><ConfirmButton className="link danger-link" message="Batalkan meeting ini? Klien akan diberi tahu.">Batalkan</ConfirmButton></form>}
                </div>
              ))}
            </div>
            {!closed && activeTypes.length > 0 && slotType && (
              <>
                {activeTypes.length > 1 && <nav className="chips">{activeTypes.map((t) => <Link key={t.id} href={`/w/${slug}/tiket/${number}?type=${t.id}`} className={t.id === slotType.id ? "on" : ""}>{t.title}</Link>)}</nav>}
                <Suspense fallback={<small>Memuat slot kosong…</small>}>
                  <ScheduleForm pool={pool} actor={actor} slug={slug} number={number} slotType={slotType} tz={tz} />
                </Suspense>
              </>
            )}
            {!closed && activeTypes.length === 0 && <small>Buat layanan di <Link href={`/w/${slug}/jadwal`}>Jadwal &amp; layanan</Link> untuk menjadwalkan meeting.</small>}
          </section>
        </aside>
      </div>
    </>
  );
}
