import { getPublicOverview } from "@jadwalin/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { currentUser, getPool } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Halaman publik jadwalin.id/<slug>: pilih jadwal atau kirim pesan (tiket). Hanya data publik yang tampil. */
export default async function PublicWorkspacePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const overview = await getPublicOverview(getPool(), slug);
  if (!overview) notFound();
  const { workspace, types } = overview;
  const user = await currentUser();
  const target = `/jadwal-saya/${workspace.slug}`;

  return (
    <>
      <h1>{workspace.name}</h1>

      {types.length > 0 && (
        <>
          <h2>Pesan jadwal</h2>
          {types.map((t) => (
            <div className="card" key={t.id}>
              <span>{t.title} <small>{t.durationMin} menit</small></span>
              <Link href={`/${workspace.slug}/${t.slug}`}>Pilih waktu →</Link>
            </div>
          ))}
        </>
      )}

      <h2>Kirim pesan</h2>
      <p>Punya pertanyaan? Kirim pesan lewat tiket, lampirkan dokumen pendukung, dan lacak balasannya.</p>
      {user ? (
        <p><Link href={target}><button>Kirim pesan / lihat tiket Anda</button></Link></p>
      ) : (
        <p><Link href={`/masuk?next=${encodeURIComponent(target)}`}>Masuk</Link> atau <Link href="/daftar">daftar</Link> untuk mengirim pesan. <small>Memesan jadwal tidak perlu akun.</small></p>
      )}
    </>
  );
}
