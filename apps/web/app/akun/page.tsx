import { listMyDataRequests } from "@jadwalin/core";
import Link from "next/link";
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
      <p><Link href="/dashboard">← Dashboard</Link></p>
      <h1>Akun</h1>
      <p>{user.name} · {user.email}</p>

      <h2>Data saya</h2>
      <p>Unduh salinan data pribadi yang kami simpan tentang Anda (format JSON).</p>
      <p><a href="/akun/ekspor" download>Unduh data saya</a></p>

      <h2>Hapus akun</h2>
      {pendingDelete ? (
        <p className="error" role="status">Permintaan penghapusan diterima pada {pendingDelete.createdAt.toLocaleDateString("id-ID")}. Kami memprosesnya paling lambat 30 hari dan mengonfirmasi lewat email.</p>
      ) : (
        <>
          <p>Kami menghapus akun dan data pribadi Anda, kecuali yang wajib disimpan menurut hukum. Pemilik workspace perlu menyerahkan atau menghapus workspace-nya lebih dulu. Proses ini tidak dapat dibatalkan.</p>
          <form action={requestDeletionAction}>
            {error && <p className="error" role="alert">{error}</p>}
            {ok && <p role="status">Permintaan tercatat.</p>}
            <button>Ajukan penghapusan akun</button>
          </form>
        </>
      )}
      <p><small>Lihat <Link href="/privasi">Kebijakan Privasi</Link> untuk hak Anda lainnya.</small></p>
    </>
  );
}
