import { listMyWorkspaces } from "@jadwalin/core";
import { listProducts } from "@jadwalin/module-rental";
import { notFound } from "next/navigation";
import { FeatureOff } from "@/components/feature-off";
import { MoneyField } from "@/components/money-input";
import { ProductImageUploader } from "@/components/product-image-uploader";
import { fmtIdr } from "@/lib/format";
import { saveProductAction, toggleProductAction } from "@/lib/rental-actions";
import { getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function ProdukPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; tersimpan?: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const { error, tersimpan } = await searchParams;
  const mine = (await listMyWorkspaces(getPool(), user.id)).find((w) => w.slug === slug);
  if (!mine) notFound();
  const canManage = mine.role === "owner" || mine.role === "admin";
  if (!mine.features.sewa) return <FeatureOff feature="sewa" slug={slug} canManage={canManage} />;
  const products = await listProducts(getPool(), { userId: user.id, slug });

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Produk sewa</h1>
          <p>Barang yang bisa disewa pelanggan. Pelanggan memilih tanggal; sistem mencegah unit yang sama tersewa ganda.</p>
        </div>
        <a className="btn btn-ghost" href={`/${slug}`} target="_blank" rel="noopener">Lihat katalog publik ↗</a>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {tersimpan && <p className="notice ok" role="status">Perubahan tersimpan.</p>}

      {products.length === 0 && <div className="empty"><strong>Belum ada produk.</strong><small>Tambahkan produk pertama Anda di bawah.</small></div>}
      <div className="prod-grid">
        {products.map((p) => (
          <article className={`prod-card${p.active ? "" : " off"}`} key={p.id}>
            <div className="prod-img">
              {p.imageFileId && p.active ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={`/foto/${slug}/${p.id}`} alt={p.name} loading="lazy" /> : <span>{p.imageFileId ? "Foto (produk nonaktif)" : "Belum ada foto"}</span>}
            </div>
            <div className="prod-body">
              <div className="prod-top">
                <div><strong>{p.name}</strong>{p.category && <small>{p.category}</small>}</div>
                <span className={`badge ${p.active ? "ok" : ""}`}>{p.active ? "Aktif" : "Nonaktif"}</span>
              </div>
              <div className="svc-meta">
                <span className="badge">{fmtIdr(p.pricePerDayIdr)} / hari</span>
                <span className="badge">{p.units} unit</span>
                {p.dpPercent > 0 && mine.features.pembayaran && <span className="badge warn">DP {p.dpPercent}%</span>}
                {p.depositIdr > 0 && <span className="badge">Jaminan {fmtIdr(p.depositIdr)}</span>}
              </div>
              {canManage && (
                <>
                  <details className="fold slim">
                    <summary>Ubah produk</summary>
                    <ProductForm slug={slug} product={p} dpOn={mine.features.pembayaran} />
                  </details>
                  <form action={toggleProductAction.bind(null, slug, p.id, !p.active)} style={{ margin: 0 }}>
                    <button className="link">{p.active ? "Nonaktifkan" : "Aktifkan"}</button>
                  </form>
                </>
              )}
            </div>
          </article>
        ))}
      </div>

      {canManage && (
        <details className="fold" open={products.length === 0 || Boolean(error)}>
          <summary>+ Tambah produk</summary>
          <ProductForm slug={slug} dpOn={mine.features.pembayaran} />
        </details>
      )}
    </>
  );
}

function ProductForm({ slug, product, dpOn }: { slug: string; product?: Awaited<ReturnType<typeof listProducts>>[number]; dpOn: boolean }) {
  return (
    <form action={saveProductAction.bind(null, slug, product?.id ?? null)}>
      <ProductImageUploader slug={slug} currentUrl={product?.imageFileId && product.active ? `/foto/${slug}/${product.id}` : null} />
      <div className="two">
        <label>Nama produk<input name="name" required minLength={2} maxLength={80} defaultValue={product?.name} placeholder="mis. Toyota Avanza" /></label>
        <label>Kategori <small>(opsional)</small><input name="category" maxLength={40} defaultValue={product?.category ?? ""} placeholder="mis. Mobil" /></label>
      </div>
      <div className="two">
        <label>Harga per hari<MoneyField name="pricePerDayIdr" required defaultValue={product?.pricePerDayIdr ?? 0} placeholder="450.000" /></label>
        <label>Jumlah unit<input name="units" type="number" min={1} max={50} required defaultValue={product?.units ?? 1} /></label>
      </div>
      <div className="two">
        {dpOn
          ? <label>DP (% dari total sewa) <small>0 = tanpa DP</small><span className="pct"><input name="dpPercent" type="number" min={0} max={100} defaultValue={product?.dpPercent ?? 0} /><span aria-hidden="true">%</span></span></label>
          : <label>DP<input disabled value="Nyalakan fitur DP di Pengaturan" /></label>}
        <label>Uang jaminan saat ambil barang <small>(dikembalikan; opsional)</small><MoneyField name="depositIdr" defaultValue={product?.depositIdr ?? 0} placeholder="0" /></label>
      </div>
      <p className="prod-how"><small><b>DP</b> dibayar pelanggan di depan (lewat bukti transfer) supaya unit terkunci. <b>Jaminan</b> diserahkan saat ambil barang dan dikembalikan saat barang kembali. Keduanya langsung ke Anda; jadwalin.id tidak memproses uang.</small></p>
      <label>Deskripsi <small>(kelengkapan, syarat, dll.)</small><textarea name="description" rows={3} maxLength={2000} defaultValue={product?.description ?? ""} /></label>
      <button>{product ? "Simpan perubahan" : "Tambah produk"}</button>
    </form>
  );
}
