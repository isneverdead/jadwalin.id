import { getProductAvailability, getPublicProduct, todayLocal } from "@jadwalin/module-rental";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RentalPicker } from "@/components/rental-picker";
import { Turnstile } from "@/components/turnstile";
import { fmtIdr } from "@/lib/format";
import { requestRentalAction } from "@/lib/rental-actions";
import { getPool } from "@/lib/server";
import { loadTurnstileEnv } from "@jadwalin/config";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

const HORIZON_DAYS = 92;

export default async function ProdukPublikPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { slug, id } = await params;
  const { error } = await searchParams;
  const found = await getPublicProduct(getPool(), slug, id);
  if (!found) notFound();
  const { workspace, product } = found;
  const today = todayLocal(new Date(), workspace.timezone);
  const days = (await getProductAvailability(getPool(), slug, id, { fromDate: today, count: 62 })).concat(
    (await getProductAvailability(getPool(), slug, id, { fromDate: new Date(Date.parse(today) + 62 * 86400000).toISOString().slice(0, 10), count: HORIZON_DAYS - 62 })),
  );
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const siteKey = loadTurnstileEnv().siteKey;

  return (
    <div className="wide">
      <p className="crumb"><Link href={`/${slug}`}>← {workspace.name}</Link></p>
      <div className="book-grid">
        <aside className="book-aside">
          <div className="prod-img prod-img-lg">
            {product.hasImage ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={`/foto/${slug}/${product.id}`} alt={product.name} /> : <span>Tanpa foto</span>}
          </div>
          <p className="aside-org">{workspace.name}{product.category ? ` · ${product.category}` : ""}</p>
          <h1>{product.name}</h1>
          <ul className="facts">
            <li className="price">{fmtIdr(product.pricePerDayIdr)} / hari</li>
            {product.dpPercent > 0 && workspace.features.pembayaran && <li><span aria-hidden="true">💳</span> DP {product.dpPercent}% dari total, dibayar setelah memilih tanggal</li>}
            {product.depositIdr > 0 && <li><span aria-hidden="true">🔑</span> Jaminan {fmtIdr(product.depositIdr)} diserahkan saat ambil barang (dikembalikan)</li>}
          </ul>
          {product.description && <p className="prod-desc">{product.description}</p>}
        </aside>

        <section className="book-main">
          <form action={requestRentalAction.bind(null, slug, id)}>
            <h2 className="step"><span className="step-n">1</span>Pilih tanggal sewa</h2>
            <RentalPicker days={days} pricePerDayIdr={product.pricePerDayIdr} />

            <h2 className="step"><span className="step-n">2</span>Data Anda</h2>
            <div className="two">
              <label>Nama<input name="name" required minLength={2} maxLength={100} autoComplete="name" /></label>
              <label>Nomor HP / WhatsApp <small>(untuk serah-terima)</small><input name="phone" type="tel" required autoComplete="tel" inputMode="tel" placeholder="0812…" /></label>
            </div>
            <label>Catatan <small>(opsional)</small><textarea name="note" rows={3} maxLength={1000} placeholder="mis. jam ambil yang diinginkan, keperluan sewa" /></label>
            <input name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: "absolute", left: "-9999px", height: 0, width: 0, opacity: 0 }} />
            <label className="check"><input type="checkbox" name="privacy" required /><span>Saya telah membaca <a href="/privasi" target="_blank" rel="noopener">pemberitahuan privasi</a>; data saya diproses oleh {workspace.name} dan jadwalin.id untuk pesanan sewa ini.</span></label>
            {siteKey && <Turnstile siteKey={siteKey} nonce={nonce} />}
            {error && <p className="error" role="alert">{error}</p>}
            <button className="cta">{product.dpPercent > 0 && workspace.features.pembayaran ? "Lanjut ke pembayaran DP" : "Ajukan sewa"}</button>
            <small>{product.dpPercent > 0 && workspace.features.pembayaran ? "Unit ditahan 3 jam setelah Anda mengajukan; bayar DP langsung ke pemilik lalu unggah bukti. " : `${workspace.name} akan mengonfirmasi pesanan Anda. `}Sisa pembayaran dan jaminan diselesaikan langsung dengan pemilik; jadwalin.id tidak memproses uang.</small>
          </form>
        </section>
      </div>
    </div>
  );
}
