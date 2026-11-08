import { AppError, listInvitations, listMembers, listMyWorkspaces } from "@jadwalin/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { inviteMemberAction, removeMemberAction, revokeInvitationAction } from "@/lib/actions";
import { getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser();
  const { slug } = await params;
  const { error } = await searchParams;

  const members = await listMembers(getPool(), { userId: user.id, slug }).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") return null;
    throw e;
  });
  if (!members) notFound();

  const mine = (await listMyWorkspaces(getPool(), user.id)).find((w) => w.slug === slug)!;
  const canManage = mine.role === "owner" || mine.role === "admin";
  const invitations = canManage ? await listInvitations(getPool(), { userId: user.id, slug }) : [];

  return (
    <>
      <p><Link href="/dashboard">← Dashboard</Link></p>
      <h1>{mine.name}</h1>
      <small>jadwalin.id/{slug} · peran Anda: {mine.role}</small>

      <p><Link href={`/w/${slug}/tiket`}>Tiket →</Link> · <Link href={`/w/${slug}/jadwal`}>Jadwal &amp; ketersediaan →</Link> · <Link href={`/w/${slug}/berkas`}>Berkas →</Link>{canManage && <> · <Link href={`/w/${slug}/audit`}>Log audit →</Link></>}</p>

      <h2>Anggota</h2>
      {members.map((m) => (
        <div className="card" key={m.id}>
          <span>{m.name} <small>{m.email} · {m.role}</small></span>
          {canManage && m.role !== "owner" && (mine.role === "owner" || m.role === "staff") && (
            <form action={removeMemberAction.bind(null, slug, m.id)}><button className="link">Keluarkan</button></form>
          )}
        </div>
      ))}

      {canManage && invitations.length > 0 && (
        <>
          <h2>Undangan tertunda</h2>
          {invitations.map((i) => (
            <div className="card" key={i.id}>
              <span>{i.email} <small>{i.role === "admin" ? "admin" : "staf"} · berlaku sampai {i.expiresAt.toLocaleDateString("id-ID")}</small></span>
              {(mine.role === "owner" || i.role === "staff") && (
                <form action={revokeInvitationAction.bind(null, slug, i.id)}><button className="link">Batalkan</button></form>
              )}
            </div>
          ))}
        </>
      )}

      {canManage && (
        <>
          <h2>Undang anggota</h2>
          <p>Kami kirim tautan undangan ke email ini. Penerima harus masuk dengan email yang sama dan sudah terverifikasi.</p>
          <form action={inviteMemberAction.bind(null, slug)}>
            <label>Email<input name="email" type="email" required /></label>
            <label>
              Peran
              <select name="role">
                <option value="staff">Staf</option>
                {mine.role === "owner" && <option value="admin">Admin</option>}
              </select>
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <button>Kirim undangan</button>
          </form>
        </>
      )}
    </>
  );
}
