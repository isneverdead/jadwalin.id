import { getPublicOverview } from "@jadwalin/core";
import { listPublicProducts } from "@jadwalin/module-rental";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fmtIdr } from "@/lib/format";
import { currentUser, getPool } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Halaman publik jadwalin.id/<slug>: pilih jadwal atau kirim pesan (tiket). Hanya data publik yang tampil. */
export default async function PublicWorkspacePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const overview = await getPublicOverview(getPool(), slug);
  if (!overview) notFound();
  const { workspace, types } = overview;
  const catalog = workspace.features.sewa ? await listPublicProducts(getPool(), slug) : null;
  const products = catalog?.products ?? [];
  const user = await currentUser();
  const target = `/jadwal-saya/${workspace.slug}`;

  const LOC = { link: "Online", phone: "Telepon", in_person: "Tatap muka" } as const;
  return (
    <>
      <header className="pub-hero">
        <span className="avatar" aria-hidden="true">{workspace.name.slice(0, 1).toUpperCase()}</span>
        <div>
          <h1>{workspace.name}</h1>
          <p>{products.length > 0 && types.length === 0 ? "Pilih barang yang ingin disewa, lalu pilih tanggalnya. Status pesanan tampil di halaman pesanan Anda." : products.length > 0 ? "Pilih layanan atau barang sewa di bawah. Status pesanan tampil di halaman pesanan Anda." : workspace.features.sewa && types.length === 0 ? "Katalog sewa sedang disiapkan." : "Pilih layanan, lalu pilih waktu yang cocok. Status booking tampil di halaman booking Anda."}</p>
        </div>
      </header>

      {products.length > 0 && (
        <>
          <h2>Katalog sewa</h2>
          <div className="prod-grid">
            {products.map((p) => (
              <Link className="prod-card prod-link" key={p.id} href={`/${workspace.slug}/produk/${p.id}`}>
                <div className="prod-img">{p.hasImage ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={`/foto/${workspace.slug}/${p.id}`} alt={p.name} loading="lazy" /> : <span>Tanpa foto</span>}</div>
                <div className="prod-body">
                  <div className="prod-top"><div><strong>{p.name}</strong>{p.category && <small>{p.category}</small>}</div></div>
                  <div className="svc-meta"><span className="badge warn">{fmtIdr(p.pricePerDayIdr)} / hari</span>{p.dpPercent > 0 && workspace.features.pembayaran && <span className="badge">DP {p.dpPercent}%</span>}</div>
                  <span className="go">Pilih tanggal →</span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      {types.length > 0 && (
        <>
          <h2>Pilih layanan</h2>
          <div className="pub-types">
            {types.map((t) => (
              <Link className="pub-type" key={t.id} href={`/${workspace.slug}/${t.slug}`}>
                <strong>{t.title}</strong>
                <span className="svc-meta">
                  <span className="badge">{t.durationMin} menit</span>
                  <span className="badge">{LOC[t.locationKind]}</span>
                  <span className={`badge ${t.depositIdr > 0 ? "warn" : "ok"}`}>{t.depositIdr > 0 ? `DP ${fmtIdr(t.depositIdr)}` : "Gratis"}</span>
                </span>
                <span className="go">Pilih waktu →</span>
              </Link>
            ))}
          </div>
        </>
      )}

      {workspace.features.tiket && (
        <>
          <h2>Kirim pesan</h2>
          <p>Punya pertanyaan? Kirim pesan lewat tiket, lampirkan dokumen pendukung, dan lacak balasannya.</p>
          {user ? (
            <p><Link href={target}><button>Kirim pesan / lihat tiket Anda</button></Link></p>
          ) : (
            <p><Link href={`/masuk?next=${encodeURIComponent(target)}`}>Masuk</Link> atau <Link href="/daftar">daftar</Link> untuk mengirim pesan. <small>Memesan tidak perlu akun.</small></p>
          )}
        </>
      )}
      {types.length === 0 && products.length === 0 && <div className="empty"><strong>{workspace.features.sewa && !workspace.features.jadwal ? "Belum ada barang yang bisa disewa." : "Belum ada layanan yang bisa dipesan."}</strong><small>Silakan kembali lagi nanti.</small></div>}
    </>
  );
}
