import { AppError, BUSINESS_TEMPLATES, listInvitations, listManualPayments, listMeetingTypes, listMembers, listMyWorkspaces } from "@jadwalin/core";
import { getRentalStats } from "@jadwalin/module-rental";
import { listTickets } from "@jadwalin/module-tickets";
import Link from "next/link";
import { ConfirmButton } from "@/components/confirm-button";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { inviteMemberAction, removeMemberAction, revokeInvitationAction } from "@/lib/actions";
import { appBaseUrl, getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

const ROLE: Record<string, string> = { owner: "Pemilik", admin: "Admin", staff: "Staf" };

export default async function RingkasanPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string; baru?: string }>;
}) {
  const user = await requireUser();
  const { slug } = await params;
  const { error, baru } = await searchParams;
  const startTemplate = baru ? BUSINESS_TEMPLATES.find((t) => t.id === baru) : undefined;
  const pool = getPool();
  const actor = { userId: user.id, slug };

  const members = await listMembers(pool, actor).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") return null;
    throw e;
  });
  if (!members) notFound();

  const mine = (await listMyWorkspaces(pool, user.id)).find((w) => w.slug === slug)!;
  const canManage = mine.role === "owner" || mine.role === "admin";
  const f = mine.features;
  const [invitations, payments, tickets, types, rental] = await Promise.all([
    canManage ? listInvitations(pool, actor) : Promise.resolve([]),
    mine.features.pembayaran ? listManualPayments(pool, actor, "open").catch(() => []) : Promise.resolve([]),
    mine.features.tiket ? listTickets(pool, actor, { status: "aktif" }).catch(() => []) : Promise.resolve([]),
    f.jadwal ? listMeetingTypes(pool, actor).catch(() => []) : Promise.resolve([]),
    f.sewa ? getRentalStats(pool, actor).catch(() => null) : Promise.resolve(null),
  ]);
  const toVerify = payments.filter((p) => p.status === "awaiting_verification").length;
  const activeTypes = types.filter((t) => t.active).length;
  let publicUrl = `jadwalin.id/${slug}`;
  let fullUrl = `/${slug}`;
  try { fullUrl = `${appBaseUrl()}/${slug}`; } catch { /* base URL belum diatur di dev */ }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Ringkasan</h1>
          <p>Yang perlu Anda lihat hari ini di {mine.name}.</p>
        </div>
      </header>

      {startTemplate && (
        <section className="card onboard">
          <div>
            <strong>Halaman Anda siap. Langkah berikutnya untuk {startTemplate.name}:</strong>
            <ol>
              {startTemplate.nextSteps.map((st) => <li key={st}>{st}</li>)}
            </ol>
          </div>
        </section>
      )}

      <section className="stat-grid" aria-label="Perlu perhatian">
        {mine.features.pembayaran && (
          <Link className="stat" href={`/w/${slug}/pembayaran`}>
            <span className="stat-n">{toVerify}</span>
            <strong>Bukti menunggu verifikasi</strong>
            <small>{toVerify > 0 ? "Periksa dan konfirmasi sekarang →" : "Tidak ada yang menunggu"}</small>
          </Link>
        )}
        {mine.features.tiket && (
          <Link className="stat" href={`/w/${slug}/tiket`}>
            <span className="stat-n">{tickets.length}</span>
            <strong>Tiket aktif</strong>
            <small>{tickets.length > 0 ? "Buka daftar tiket →" : "Belum ada tiket aktif"}</small>
          </Link>
        )}
        {f.jadwal && (
          <Link className="stat" href={`/w/${slug}/jadwal`}>
            <span className="stat-n">{activeTypes}</span>
            <strong>Layanan aktif</strong>
            <small>{activeTypes > 0 ? "Atur jam kerja dan harga →" : "Belum ada layanan. Tambahkan →"}</small>
          </Link>
        )}
        {rental && (
          <>
            <Link className="stat" href={`/w/${slug}/sewa`}>
              <span className="stat-n">{rental.pending}</span>
              <strong>Pesanan sewa menunggu</strong>
              <small>{rental.pending > 0 ? "Konfirmasi atau tolak →" : "Tidak ada yang menunggu"}</small>
            </Link>
            <Link className="stat" href={`/w/${slug}/sewa`}>
              <span className="stat-n">{rental.pickupsToday}</span>
              <strong>Diambil hari ini</strong>
              <small>{rental.confirmed} pesanan terkonfirmasi mendatang</small>
            </Link>
            <Link className="stat" href={`/w/${slug}/sewa`}>
              <span className="stat-n">{rental.active}</span>
              <strong>Sedang disewa</strong>
              <small>{rental.returnsToday > 0 ? `${rental.returnsToday} kembali hari ini` : "Belum ada yang jatuh tempo hari ini"}</small>
            </Link>
            <Link className="stat" href={`/w/${slug}/produk`}>
              <span className="stat-n">{rental.activeProducts}</span>
              <strong>Produk aktif</strong>
              <small>{rental.products === 0 ? "Belum ada produk. Tambahkan →" : "Kelola katalog dan foto →"}</small>
            </Link>
          </>
        )}
      </section>

      <section className="card share">
        <div>
          <strong>{f.sewa && !f.jadwal ? "Link katalog untuk pelanggan" : "Link untuk pelanggan"}</strong>
          <small>Tempel di bio Instagram, WhatsApp, atau kartu nama.</small>
          <code>{publicUrl}</code>
        </div>
        <span className="row-btns">
          <CopyButton text={fullUrl} label="Salin link" />
          <a className="btn btn-ghost" href={`/${slug}`} target="_blank" rel="noopener">Buka ↗</a>
        </span>
      </section>

      <h2>Anggota tim</h2>
      <div className="list">
        {members.map((m) => (
          <div className="list-row" key={m.id}>
            <span className="avatar sm" aria-hidden="true">{m.name.slice(0, 1).toUpperCase()}</span>
            <span className="grow"><strong>{m.name}</strong><small>{m.email}</small></span>
            <span className="badge">{ROLE[m.role] ?? m.role}</span>
            {canManage && m.role !== "owner" && (mine.role === "owner" || m.role === "staff") && (
              <form action={removeMemberAction.bind(null, slug, m.id)}><ConfirmButton className="link danger-link" message={`Keluarkan ${m.name} dari tim ini?`}>Keluarkan</ConfirmButton></form>
            )}
          </div>
        ))}
        {canManage && invitations.map((i) => (
          <div className="list-row pending" key={i.id}>
            <span className="avatar sm ghost" aria-hidden="true">✉</span>
            <span className="grow"><strong>{i.email}</strong><small>Undangan tertunda · sampai {i.expiresAt.toLocaleDateString("id-ID")}</small></span>
            <span className="badge">{i.role === "admin" ? "Admin" : "Staf"}</span>
            {(mine.role === "owner" || i.role === "staff") && (
              <form action={revokeInvitationAction.bind(null, slug, i.id)}><ConfirmButton className="link danger-link" message="Batalkan undangan ini?">Batalkan</ConfirmButton></form>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <details className="fold" open={Boolean(error)}>
          <summary>+ Undang anggota baru</summary>
          <p>Kami kirim tautan undangan ke email ini. Penerima harus masuk dengan email yang sama dan sudah terverifikasi.</p>
          <form action={inviteMemberAction.bind(null, slug)}>
            <div className="two">
              <label>Email<input name="email" type="email" required placeholder="nama@email.com" /></label>
              <label>
                Peran
                <select name="role">
                  <option value="staff">Staf</option>
                  {mine.role === "owner" && <option value="admin">Admin</option>}
                </select>
              </label>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            <button>Kirim undangan</button>
          </form>
        </details>
      )}
    </>
  );
}
