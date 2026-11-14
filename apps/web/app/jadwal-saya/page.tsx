import { listMyClientWorkspaces } from "@jadwalin/core";
import Link from "next/link";
import { getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function JadwalSayaPage() {
  const user = await requireUser();
  const workspaces = await listMyClientWorkspaces(getPool(), user.id);
  return (
    <>
      <p className="crumb"><Link href="/dashboard">← Dashboard</Link></p>
      <header className="page-head">
        <div>
          <h1>Jadwal saya</h1>
          <p>Tempat Anda tercatat sebagai klien. Buka salah satu untuk melihat tiket dan jadwal meeting Anda.</p>
        </div>
      </header>
      {workspaces.length === 0 ? (
        <div className="empty"><strong>Anda belum tercatat sebagai klien di usaha mana pun.</strong><small>Untuk memesan, buka halaman publik usahanya: jadwalin.id/&lt;nama&gt;.</small></div>
      ) : (
        <div className="biz-grid">
          {workspaces.map((w) => (
            <Link className="biz-card" key={w.workspaceId} href={`/jadwal-saya/${w.slug}`}>
              <span className="avatar sm" aria-hidden="true">{w.name.slice(0, 1).toUpperCase()}</span>
              <span className="grow"><strong>{w.name}</strong><small>jadwalin.id/{w.slug}</small></span>
              <span className="go" aria-hidden="true">→</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
