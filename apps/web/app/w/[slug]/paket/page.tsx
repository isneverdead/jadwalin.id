import { PERIODS, PLANS, PLATFORM_BANK, PLATFORM_WHATSAPP, getSubscription, listMyWorkspaces, planPrice, waLink, type InvoiceView } from "@jadwalin/core";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { CopyButton } from "@/components/copy-button";
import { PlanProofUploader } from "@/components/plan-proof-uploader";
import { cancelInvoiceAction, createInvoiceAction } from "@/lib/plan-actions";
import { fmtDateTime, fmtIdr } from "@/lib/format";
import { appBaseUrl, getPool, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { pending: "Menunggu pembayaran", awaiting_verification: "Menunggu verifikasi", paid: "Lunas", rejected: "Ditolak", cancelled: "Dibatalkan" };
const periodLabel = (months: number) => (months === 12 ? "tahunan" : "bulanan");

export default async function PaketPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const { error } = await searchParams;
  const mine = (await listMyWorkspaces(getPool(), user.id)).find((w) => w.slug === slug);
  if (!mine || (mine.role !== "owner" && mine.role !== "admin")) notFound();
  const sub = await getSubscription(getPool(), { userId: user.id, slug });
  const isOwner = mine.role === "owner";
  const inv = sub.open;

  // Konteks untuk WhatsApp pemilik platform: siapa, usaha apa, apa yang dibayar, dan sudah sampai mana.
  const waText = (i: InvoiceView) =>
    [
      `Halo, saya ${user.name} (${user.email}), pemilik "${mine.name}" (jadwalin.id/${slug}).`,
      `Upgrade paket ${PLANS[i.plan].label} ${periodLabel(i.months)}, ${fmtIdr(i.amountIdr)}. Kode tagihan: ${i.code}.`,
      i.status === "awaiting_verification" ? "Saya sudah transfer dan mengunggah bukti di halaman Paket. Mohon diverifikasi." : "Saya akan/ sudah transfer. Bukti transfer saya lampirkan di chat ini.",
      `Halaman: ${appBaseUrl().replace(/\/$/, "")}/admin/upgrade`,
    ].join("\n");

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Paket &amp; langganan</h1>
          <p>Paket aktif untuk {mine.name}. Upgrade dibayar lewat transfer bank, lalu diverifikasi manual.</p>
        </div>
      </header>
      {error && <p className="error" role="alert">{error}</p>}

      <section className="panel">
        <div className="panel-head"><h2>Paket saat ini</h2><span className={`badge ${sub.active ? "ok" : ""}`}>{PLANS[sub.plan].label}</span></div>
        <p>
          {sub.plan === "gratis" ? "Anda memakai paket Gratis." : sub.active ? <>Paket {PLANS[sub.plan].label} aktif sampai <strong>{fmtDateTime(sub.planUntil!, mine.timezone)}</strong>.</> : <>Paket {PLANS[sub.plan].label} sudah berakhir{sub.planUntil ? ` pada ${fmtDateTime(sub.planUntil, mine.timezone)}` : ""}. Perpanjang di bawah.</>}
        </p>
        <small>Batas tiap paket sedang disiapkan dan belum diberlakukan di aplikasi; harga di bawah masih usulan.</small>
      </section>

      {inv ? (
        <section className="panel pay-box" aria-label={`Tagihan ${inv.code}`}>
          <div className="panel-head"><h2>Tagihan {inv.code}</h2><span className={`badge ${inv.status === "awaiting_verification" ? "warn" : ""}`}>{STATUS[inv.status]}</span></div>
          <p>Paket <strong>{PLANS[inv.plan].label}</strong> {periodLabel(inv.months)} · total <strong>{fmtIdr(inv.amountIdr)}</strong> <CopyButton text={String(inv.amountIdr)} label="Salin nominal" /></p>
          <div className="method">
            <strong>Transfer {PLATFORM_BANK.bank}</strong>
            <div className="acct"><code>{PLATFORM_BANK.number}</code> <CopyButton text={PLATFORM_BANK.number} /></div>
            <div>a.n. {PLATFORM_BANK.holder}</div>
            <small>Transfer tepat sesuai nominal. Cantumkan kode {inv.code} di berita transfer bila bisa.</small>
          </div>
          {inv.status === "pending" && isOwner && (
            <>
              <ol className="pay-steps pay-steps-sm" aria-label="Langkah">
                <li><span className="pay-step-n" aria-hidden="true">1</span><span>Transfer tepat <b>{fmtIdr(inv.amountIdr)}</b></span></li>
                <li><span className="pay-step-n" aria-hidden="true">2</span><span>Simpan bukti transfer</span></li>
                <li><span className="pay-step-n" aria-hidden="true">3</span><span>Unggah di bawah; paket aktif setelah diverifikasi</span></li>
              </ol>
              <PlanProofUploader slug={slug} invoiceId={inv.id} />
            </>
          )}
          {inv.status === "awaiting_verification" && <p className="notice ok">Bukti transfer diterima{inv.submittedAt ? ` (${fmtDateTime(inv.submittedAt, mine.timezone)})` : ""}. Paket aktif setelah diverifikasi. Anda juga bisa mempercepatnya lewat WhatsApp.</p>}
          <p className="row-btns">
            <a className="btn btn-ghost btn-sm" target="_blank" rel="noopener" href={waLink(PLATFORM_WHATSAPP, waText(inv))}>Kirim bukti &amp; konteks lewat WhatsApp ↗</a>
            {isOwner && <form action={cancelInvoiceAction.bind(null, slug, inv.id)}><ConfirmButton className="link danger-link" message="Batalkan tagihan ini? Bila sudah transfer, hubungi kami lebih dulu.">Batalkan tagihan</ConfirmButton></form>}
          </p>
        </section>
      ) : isOwner ? (
        <section className="panel" aria-label="Upgrade paket">
          <div className="panel-head"><h2>Upgrade paket</h2><p>Pilih paket dan periode. Tahunan hemat 2 bulan.</p></div>
          <div className="plan-grid">
            {(["pro", "bisnis"] as const).map((p) => (
              <form key={p} action={createInvoiceAction.bind(null, slug)} className="plan-card">
                <h3>{PLANS[p].label}</h3>
                <p className="plan-price">{fmtIdr(planPrice(p, 1))}<small> / bulan</small></p>
                <ul>{PLANS[p].highlights.map((h) => <li key={h}>{h}</li>)}</ul>
                <input type="hidden" name="plan" value={p} />
                <label>Periode
                  <select name="period" defaultValue="bulanan">
                    {Object.entries(PERIODS).map(([k, v]) => <option key={k} value={k}>{v.label} · {fmtIdr(planPrice(p, v.months))}</option>)}
                  </select>
                </label>
                <button className="cta">Upgrade ke {PLANS[p].label}</button>
              </form>
            ))}
          </div>
        </section>
      ) : (
        <p className="notice warn">Hanya pemilik usaha yang bisa membuat tagihan upgrade.</p>
      )}

      {sub.history.length > 0 && (
        <section className="panel">
          <div className="panel-head"><h2>Riwayat tagihan</h2></div>
          <div className="list">
            {sub.history.map((h) => (
              <div className="list-row" key={h.id}>
                <span className="grow"><strong>{h.code} · {PLANS[h.plan].label} {periodLabel(h.months)}</strong><small>{fmtIdr(h.amountIdr)} · {fmtDateTime(h.createdAt, mine.timezone)}{h.rejectReason ? ` · ditolak: ${h.rejectReason}` : ""}</small></span>
                <span className={`badge ${h.status === "paid" ? "ok" : ""}`}>{STATUS[h.status]}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
