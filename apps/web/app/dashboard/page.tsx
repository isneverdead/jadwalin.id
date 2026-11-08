import { listMyClientWorkspaces, listMyWorkspaces } from "@jadwalin/core";
import Link from "next/link";
import { createWorkspaceAction } from "@/lib/actions";
import { getPool, requireUser } from "@/lib/server";
import { LogoutButton } from "../logout-button";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser();
  const { error } = await searchParams;
  const [workspaces, asClient] = await Promise.all([
    listMyWorkspaces(getPool(), user.id),
    listMyClientWorkspaces(getPool(), user.id),
  ]);

  return (
    <>
      <div className="row">
        <h1>Halo, {user.name}</h1>
        <span><Link href="/akun">Akun</Link> <LogoutButton /></span>
      </div>

      <h2>Workspace Anda</h2>
      {workspaces.length === 0 && <p>Belum ada workspace. Buat yang pertama di bawah.</p>}
      {workspaces.map((w) => (
        <div className="card" key={w.id}>
          <Link href={`/w/${w.slug}`}>{w.name}</Link>
          <small>jadwalin.id/{w.slug} · {w.role}</small>
        </div>
      ))}

      <h2>Buat workspace</h2>
      <form action={createWorkspaceAction}>
        <label>Nama bisnis<input name="name" required minLength={2} maxLength={80} /></label>
        <label>Nama link (jadwalin.id/…)<input name="slug" required pattern="[a-z0-9-]{3,32}" placeholder="nama-anda" /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button>Buat workspace</button>
      </form>

      {asClient.length > 0 && (
        <>
          <h2><Link href="/jadwal-saya">Jadwal saya</Link></h2>
          <p>Anda tercatat sebagai klien di {asClient.length} workspace.</p>
        </>
      )}
    </>
  );
}
