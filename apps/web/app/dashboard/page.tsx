import { listMyClientWorkspaces, listMyWorkspaces } from "@jadwalin/core";
import Link from "next/link";
import { getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

const ROLE: Record<string, string> = { owner: "Pemilik", admin: "Admin", staff: "Staf" };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ dihapus?: string }> }) {
  const { dihapus } = await searchParams;
  const user = await requireUser();
  const [workspaces, asClient] = await Promise.all([
    listMyWorkspaces(getPool(), user.id),
    listMyClientWorkspaces(getPool(), user.id),
  ]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Halo, {user.name}</h1>
          <p>{workspaces.length > 0 ? "Pilih usaha yang ingin Anda kelola." : "Selamat datang! Mulai dengan membuat usaha pertama Anda."}</p>
        </div>
      </header>

      {dihapus && <p className="notice ok" role="status">Usaha sudah dihapus.</p>}

      {workspaces.length === 0 ? (
        <div className="empty">
          <strong>Belum ada usaha.</strong>
          <small>Pilih bidang Anda; kami siapkan layanan, jam kerja, dan fitur yang cocok dalam satu menit.</small>
          <p><Link className="btn" href="/dashboard/bisnis-baru">Buat usaha pertama</Link></p>
        </div>
      ) : (
        <>
          <div className="biz-grid">
            {workspaces.map((w) => (
              <Link className="biz-card" key={w.id} href={`/w/${w.slug}`}>
                <span className="avatar sm" aria-hidden="true">{w.name.slice(0, 1).toUpperCase()}</span>
                <span className="grow"><strong>{w.name}</strong><small>jadwalin.id/{w.slug}</small></span>
                <span className="badge">{ROLE[w.role] ?? w.role}</span>
                <span className="go" aria-hidden="true">→</span>
              </Link>
            ))}
          </div>
          <p><Link className="btn btn-ghost" href="/dashboard/bisnis-baru">+ Tambah usaha</Link></p>
        </>
      )}

      {asClient.length > 0 && (
        <section className="panel" style={{ marginTop: 28 }}>
          <div className="panel-head"><h2>Sebagai klien</h2><p>Anda tercatat sebagai klien di {asClient.length} usaha.</p></div>
          <Link className="btn btn-ghost" href="/jadwal-saya">Buka jadwal saya</Link>
        </section>
      )}
    </>
  );
}
