import { listMyClientWorkspaces } from "@jadwalin/core";
import Link from "next/link";
import { getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function JadwalSayaPage() {
  const user = await requireUser();
  const workspaces = await listMyClientWorkspaces(getPool(), user.id);
  return (
    <>
      <p><Link href="/dashboard">← Dashboard</Link></p>
      <h1>Jadwal saya</h1>
      {workspaces.length === 0 ? (
        <p>Anda belum tercatat sebagai klien di workspace mana pun.</p>
      ) : (
        workspaces.map((w) => (
          <div className="card" key={w.workspaceId}><Link href={`/jadwal-saya/${w.slug}`}>{w.name}</Link><small>jadwalin.id/{w.slug}</small></div>
        ))
      )}
      <p><small>Buka salah satu untuk melihat tiket dan jadwal meeting Anda. Untuk menghubungi workspace baru, buka jadwalin.id/&lt;nama-workspace&gt;.</small></p>
    </>
  );
}
