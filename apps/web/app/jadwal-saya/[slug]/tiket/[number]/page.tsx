import { AppError } from "@jadwalin/core";
import { getMyTicket } from "@jadwalin/module-tickets";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AttachmentUploader } from "@/components/attachment-uploader";
import { STATUS_LABEL, describeEvent, fmtDateTime, fmtSize } from "@/lib/format";
import { getPool, requireUser } from "@/lib/server";
import { clientCommentAction, clientSetStatusAction, confirmClientAttachmentAction, requestClientAttachmentAction } from "@/lib/ticket-actions";

export const dynamic = "force-dynamic";

export default async function ClientTicketPage({ params, searchParams }: { params: Promise<{ slug: string; number: string }>; searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser();
  const { slug, number: numStr } = await params;
  const { error } = await searchParams;
  const number = Number(numStr);

  const v = await getMyTicket(getPool(), user.id, slug, number).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") return null;
    throw e;
  });
  if (!v) notFound();
  const tz = v.timezone;
  const closed = v.ticket.status === "closed";

  const timeline = [
    ...v.comments.map((c) => ({ at: c.createdAt, kind: "comment" as const, c })),
    ...v.events.map((e) => ({ at: e.createdAt, kind: "event" as const, e })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <>
      <p><Link href={`/jadwal-saya/${slug}`}>← {v.workspaceName}</Link></p>
      <h1>#{v.ticket.number} {v.ticket.title}</h1>
      <p><small>Status: {STATUS_LABEL[v.ticket.status]}</small></p>
      {error && <p className="error" role="alert">{error}</p>}
      {v.ticket.description && <div className="card" style={{ whiteSpace: "pre-wrap", display: "block" }}>{v.ticket.description}</div>}

      {v.meetings.length > 0 && <h2>Meeting</h2>}
      {v.meetings.map((m) => (
        <div className="card" key={m.bookingId}>
          <span>
            {m.title} — <strong>{fmtDateTime(m.startsAt, tz)}</strong> <small>({m.status === "cancelled" ? "dibatalkan" : "terjadwal"})</small>
            {m.status !== "cancelled" && m.locationValue && <><br /><small>{m.locationKind === "link" ? <a href={m.locationValue}>{m.locationValue}</a> : m.locationValue}</small></>}
          </span>
        </div>
      ))}

      <h2>Percakapan</h2>
      {timeline.map((item) =>
        item.kind === "comment" ? (
          <div className="card" key={item.c.id} style={{ display: "block" }}>
            <small>{item.c.authorKind === "client" ? "Anda" : `Tim ${v.workspaceName}`} · {fmtDateTime(item.c.createdAt, tz)}</small>
            <div style={{ whiteSpace: "pre-wrap" }}>{item.c.body}</div>
          </div>
        ) : (
          <p key={item.e.id}><small>• {describeEvent(item.e, item.e.byMe ? "Anda" : "Tim")} · {fmtDateTime(item.e.createdAt, tz)}</small></p>
        ),
      )}

      {!closed && !v.blocked && (
        <form action={clientCommentAction.bind(null, slug, number)}>
          <label>Balas<textarea name="body" rows={4} required maxLength={10000} /></label>
          <button>Kirim</button>
        </form>
      )}

      <h2>Lampiran</h2>
      {v.attachments.length === 0 && <p><small>Belum ada lampiran.</small></p>}
      {v.attachments.map((a) => (
        <div className="card" key={a.id}>
          <span><a href={`/jadwal-saya/${slug}/tiket/${number}/lampiran/${a.id}`}>{a.filename}</a> <small>{fmtSize(a.sizeBytes)}</small>{a.contextNote && <><br /><small>Konteks: {a.contextNote}</small></>}</span>
        </div>
      ))}
      {!closed && !v.blocked && (
        <AttachmentUploader request={requestClientAttachmentAction.bind(null, slug, number)} confirm={confirmClientAttachmentAction.bind(null, slug, number)} />
      )}

      {!v.blocked && !closed && (
        <p>
          {v.ticket.status === "resolved" && <form action={clientSetStatusAction.bind(null, slug, number, "open")} style={{ display: "inline" }}><button className="link">Masalah belum beres, buka kembali</button></form>}{" "}
          <form action={clientSetStatusAction.bind(null, slug, number, "closed")} style={{ display: "inline" }}><button className="link">Tutup tiket ini</button></form>
        </p>
      )}
    </>
  );
}
