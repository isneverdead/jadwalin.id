import { listMyDataRequests } from "@jadwalin/core";
import Link from "next/link";
import { ConfirmButton } from "@/components/confirm-button";
import { requestDeletionAction } from "@/lib/actions";
import { getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Akun — jadwalin.id" };

export default async function AkunPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const user = await requireUser();
  const { error, ok } = await searchParams;
  const requests = await listMyDataRequests(getPool(), user.id);
  const pendingDelete = requests.find((r) => r.kind === "delete" && r.status === "pending");
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Akun</h1>
          <p>{user.name} · {user.email}</p>
        </div>
        <Link className="btn btn-ghost" href="/dashboard">← Dashboard</Link>
      </header>

      <section className="panel">
        <div className="panel-head"><h2>Data saya</h2><p>Unduh salinan data pribadi yang kami simpan tentang Anda (format JSON).</p></div>
        <a className="btn btn-ghost" href="/akun/ekspor" download>Unduh data saya</a>
      </section>

      <section className="panel danger-zone">
        <div className="panel-head"><h2>Hapus akun</h2></div>
        {pendingDelete ? (
          <p className="notice warn" role="status">Permintaan penghapusan diterima pada {pendingDelete.createdAt.toLocaleDateString("id-ID")}. Kami memprosesnya paling lambat 30 hari dan mengonfirmasi lewat email.</p>
        ) : (
          <>
            <p>Kami menghapus akun dan data pribadi Anda, kecuali yang wajib disimpan menurut hukum. Pemilik usaha perlu menyerahkan atau menghapus usahanya lebih dulu. Proses ini tidak dapat dibatalkan.</p>
            <form action={requestDeletionAction}>
              {error && <p className="error" role="alert">{error}</p>}
              {ok && <p role="status">Permintaan tercatat.</p>}
              <ConfirmButton className="danger" message="Ajukan penghapusan akun? Proses ini tidak dapat dibatalkan.">Ajukan penghapusan akun</ConfirmButton>
            </form>
          </>
        )}
      </section>
      <p><small>Lihat <Link href="/privasi">Kebijakan Privasi</Link> untuk hak Anda lainnya.</small></p>
    </>
  );
}
