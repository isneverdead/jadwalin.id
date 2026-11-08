import { AppError, listAvailableSlots, listMeetingTypes, listMembers } from "@jadwalin/core";
import { getTicket, canTransition, TICKET_STATUSES, type TicketStatus } from "@jadwalin/module-tickets";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AttachmentUploader } from "@/components/attachment-uploader";
import { PRIORITY_LABEL, STATUS_LABEL, describeEvent, fmtDateTime, fmtSize } from "@/lib/format";
import { getPool, requireUser } from "@/lib/server";
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
import { listMyWorkspaces } from "@jadwalin/core";

export const dynamic = "force-dynamic";

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

  const d = await getTicket(pool, actor, number).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") return null;
    throw e;
  });
  if (!d) notFound();
  const { ticket, client } = d;
  const mine = (await listMyWorkspaces(pool, user.id)).find((w) => w.slug === slug)!;
  const tz = mine.timezone;
  const [members, types] = await Promise.all([listMembers(pool, actor), listMeetingTypes(pool, actor)]);
  const activeTypes = types.filter((t) => t.active);
  const slotType = activeTypes.find((t) => t.id === type) ?? activeTypes[0];
  const slots = slotType && ticket.status !== "closed" ? (await listAvailableSlots(pool, actor, { meetingTypeId: slotType.id }).catch(() => [])).slice(0, 40) : [];
  const nextStatuses = TICKET_STATUSES.filter((s) => canTransition(ticket.status, s as TicketStatus, "staff"));
  const closed = ticket.status === "closed";

  // Garis waktu gabungan: komentar dan riwayat, urut waktu.
  const timeline = [
    ...d.comments.map((c) => ({ at: c.createdAt, kind: "comment" as const, c })),
    ...d.events.map((e) => ({ at: e.createdAt, kind: "event" as const, e })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <>
      <p><Link href={`/w/${slug}/tiket`}>← Semua tiket</Link></p>
      <h1>#{ticket.number} {ticket.title}</h1>
      <p><small>
        {STATUS_LABEL[ticket.status]} · prioritas {PRIORITY_LABEL[ticket.priority]} · klien {client?.name ?? "—"}{client?.email ? ` (${client.email})` : ""} · {d.assignee ? `ditangani ${d.assignee.name}` : "belum ditugaskan"}
      </small></p>
      {error && <p className="error" role="alert">{error}</p>}
      {ticket.description && <div className="card" style={{ whiteSpace: "pre-wrap", display: "block" }}>{ticket.description}</div>}

      {!closed && (
        <div className="card" style={{ display: "grid", gap: 8 }}>
          <form action={setStatusAction.bind(null, slug, number)} style={{ gridTemplateColumns: "1fr auto", margin: 0 }}>
            <select name="status" aria-label="Status">{nextStatuses.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
            <button>Ubah status</button>
          </form>
          <form action={setPriorityAction.bind(null, slug, number)} style={{ gridTemplateColumns: "1fr auto", margin: 0 }}>
            <select name="priority" defaultValue={ticket.priority} aria-label="Prioritas">{Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <button>Ubah prioritas</button>
          </form>
          <form action={assignAction.bind(null, slug, number)} style={{ gridTemplateColumns: "1fr auto", margin: 0 }}>
            <select name="assignee" defaultValue={ticket.assigneeMemberId ?? ""} aria-label="Penanggung jawab"><option value="">Belum ditugaskan</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            <button>Tugaskan</button>
          </form>
        </div>
      )}

      <h2>Percakapan & riwayat</h2>
      {timeline.map((item) =>
        item.kind === "comment" ? (
          <div className="card" key={item.c.id} style={{ display: "block", borderColor: item.c.internal ? "#b45309" : undefined }}>
            <small>{item.c.authorName ?? "—"} · {item.c.authorKind === "client" ? "klien" : "tim"}{item.c.internal ? " · CATATAN INTERNAL (tidak terlihat klien)" : ""} · {fmtDateTime(item.c.createdAt, tz)}</small>
            <div style={{ whiteSpace: "pre-wrap" }}>{item.c.body}</div>
          </div>
        ) : (
          <p key={item.e.id}><small>• {describeEvent(item.e, item.e.actorName ?? "Seseorang")} · {fmtDateTime(item.e.createdAt, tz)}</small></p>
        ),
      )}

      {!closed && (
        <form action={staffCommentAction.bind(null, slug, number)}>
          <label>Balas<textarea name="body" rows={4} required maxLength={10000} /></label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input name="internal" type="checkbox" style={{ width: 18, height: 18 }} /> Catatan internal (jangan kirim ke klien)</label>
          <button>Kirim</button>
        </form>
      )}

      <h2>Lampiran</h2>
      {d.attachments.length === 0 && <p><small>Belum ada lampiran.</small></p>}
      {d.attachments.map((a) => (
        <div className="card" key={a.id}>
          <span>
            <a href={`/w/${slug}/tiket/${number}/lampiran/${a.id}`}>{a.filename}</a> <small>{fmtSize(a.sizeBytes)} · {a.uploadedByName ?? "—"}{a.clientVisible ? "" : " · tersembunyi dari klien"}</small>
            {a.contextNote && <><br /><small>Konteks: {a.contextNote}</small></>}
          </span>
        </div>
      ))}
      {!closed && (
        <AttachmentUploader
          allowHidden
          request={requestStaffAttachmentAction.bind(null, slug, number)}
          confirm={confirmStaffAttachmentAction.bind(null, slug, number)}
        />
      )}

      <h2>Meeting</h2>
      {d.meetings.length === 0 && <p><small>Belum ada meeting.</small></p>}
      {d.meetings.map((m) => (
        <div className="card" key={m.bookingId}>
          <span>
            {m.title} — {fmtDateTime(m.startsAt, tz)} <small>({m.status === "cancelled" ? "dibatalkan" : "terjadwal"} · {m.memberName ?? "—"})</small>
            {m.locationValue && <><br /><small>{m.locationKind === "link" ? <a href={m.locationValue}>{m.locationValue}</a> : m.locationValue}</small></>}
          </span>
          {m.status !== "cancelled" && !closed && <form action={cancelMeetingAction.bind(null, slug, number, m.bookingId)}><button className="link">Batalkan</button></form>}
        </div>
      ))}
      {!closed && activeTypes.length > 0 && (
        <>
          {activeTypes.length > 1 && <p>{activeTypes.map((t) => <span key={t.id}><Link href={`/w/${slug}/tiket/${number}?type=${t.id}`}>{t.title}</Link>{" "}</span>)}</p>}
          {slots.length === 0 ? (
            <p><small>Tidak ada slot kosong di kalender Anda. Atur jam rutin di <Link href={`/w/${slug}/jadwal`}>Jadwal & ketersediaan</Link>.</small></p>
          ) : (
            <form action={scheduleMeetingAction.bind(null, slug, number)}>
              <input type="hidden" name="meetingTypeId" value={slotType!.id} />
              <label>Jadwalkan “{slotType!.title}” (kalender Anda)
                <select name="startsAt" required>{slots.map((s) => <option key={s.start.toISOString()} value={s.start.toISOString()}>{fmtDateTime(s.start, tz)}</option>)}</select>
              </label>
              <button>Jadwalkan & beri tahu klien</button>
            </form>
          )}
        </>
      )}
      {!closed && activeTypes.length === 0 && <p><small>Buat jenis pertemuan di <Link href={`/w/${slug}/jadwal`}>Jadwal & ketersediaan</Link> untuk menjadwalkan meeting.</small></p>}
    </>
  );
}
