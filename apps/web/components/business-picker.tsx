"use client";
import { useMemo, useState } from "react";
import { HelpTip } from "./help-tip";
import { MoneyInput } from "./money-input";

export interface TemplateCard {
  id: string;
  name: string;
  group: string;
  tagline: string;
  example: string;
  meetingTypes: { title: string; durationMin: number; depositIdr: number; locationKind: "link" | "phone" | "in_person"; slotStepMin: number }[];
  availability: { weekday: number; start: string; end: string }[];
  nextSteps: string[];
  features: { jadwal: boolean; tiket: boolean; pembayaran: boolean; berkas: boolean; sewa: boolean };
  kind: "jadwal" | "sewa";
  products: { name: string; category: string; description: string; pricePerDayIdr: number; depositIdr: number; dpPercent?: number; units: number }[];
  featureWhy: string;
  nameLabel: string;
  personal: boolean;
}

type Svc = { title: string; durationMin: number; depositIdr: number; locationKind: "link" | "phone" | "in_person"; slotStepMin?: number };
type Range = { start: string; end: string };
type Prod = { name: string; category: string; description: string; pricePerDayIdr: number; depositIdr: number; dpPercent: number; units: number };
type Hours = Record<number, Range[]>;
const DAYS: [number, string][] = [[1, "Senin"], [2, "Selasa"], [3, "Rabu"], [4, "Kamis"], [5, "Jumat"], [6, "Sabtu"], [0, "Minggu"]];
const MAX_SERVICES = 10;

function toHours(av: TemplateCard["availability"]): Hours {
  const h: Hours = {};
  for (const r of av) (h[r.weekday] ??= []).push({ start: r.start, end: r.end });
  return h;
}

export interface FeatureInfoCard { key: "jadwal" | "tiket" | "pembayaran" | "berkas" | "sewa"; label: string; description: string; offHint: string }

function toSlug(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

export function BusinessPicker({ templates, featureInfo, action, error }: { templates: TemplateCard[]; featureInfo: FeatureInfoCard[]; action: (form: FormData) => void | Promise<void>; error?: string }) {
  const [tpl, setTpl] = useState<string>(templates[0]?.id ?? "kosong");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const current = templates.find((t) => t.id === tpl)!;
  // Saran fitur mengikuti template sampai pemilik menyentuh sakelarnya; sesudah itu pilihannya dihormati.
  const [override, setOverride] = useState<Partial<Record<"jadwal" | "tiket" | "pembayaran" | "berkas" | "sewa", boolean>>>({});
  const feat = { ...current.features, ...override };
  // Template hanyalah titik awal: layanan dan jam kerja bisa diubah sebelum halaman dibuat.
  const [services, setServices] = useState<Svc[]>(() => templates[0]!.meetingTypes.map((m) => ({ ...m })));
  const [hours, setHours] = useState<Hours>(() => toHours(templates[0]!.availability));
  const [products, setProducts] = useState<Prod[]>(() => templates[0]!.products.map((p) => ({ ...p, dpPercent: p.dpPercent ?? 0 })));
  const patchProd = (i: number, patch: Partial<Prod>) => setProducts((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  function pick(id: string) {
    const t = templates.find((x) => x.id === id)!;
    setTpl(id);
    setOverride({});
    setServices(t.meetingTypes.map((m) => ({ ...m })));
    setHours(toHours(t.availability));
    setProducts(t.products.map((p) => ({ ...p, dpPercent: p.dpPercent ?? 0 })));
  }
  const patchSvc = (i: number, patch: Partial<Svc>) => setServices((l) => l.map((x, j) => (j === i ? { ...x, ...patch, slotStepMin: "durationMin" in patch ? undefined : x.slotStepMin } : x)));
  const patchRange = (d: number, i: number, patch: Partial<Range>) => setHours((h) => ({ ...h, [d]: (h[d] ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const showSchedule = feat.jadwal;
  const setup = JSON.stringify({
    products: feat.sewa ? products.filter((p) => p.name.trim()).map((p) => ({ name: p.name, category: p.category, description: p.description, pricePerDayIdr: Number(p.pricePerDayIdr) || 0, depositIdr: Number(p.depositIdr) || 0, dpPercent: feat.pembayaran ? Math.min(100, Math.max(0, Number(p.dpPercent) || 0)) : 0, units: Number(p.units) || 1 })) : [],
    availability: Object.entries(hours).flatMap(([d, rs]) => rs.map((r) => ({ weekday: Number(d), start: r.start, end: r.end }))),
    services: services.map((x) => ({ title: x.title, durationMin: Number(x.durationMin), depositIdr: feat.pembayaran ? Number(x.depositIdr) || 0 : 0, locationKind: x.locationKind, ...(x.slotStepMin ? { slotStepMin: x.slotStepMin } : {}) })),
  });
  const groups = useMemo(() => [...new Set(templates.map((t) => t.group))], [templates]);

  return (
    <form action={action} className="biz-form">
      <div className="help-hint" role="note">
        <span className="help-btn demo" aria-hidden="true"><span className="help-q">?</span><span className="help-label">Cara pakai</span></span>
        <span>Bingung? Klik tombol <b>Cara pakai</b> di samping judul tiap bagian untuk melihat panduan animasi singkat.</span>
      </div>
      <h2 className="step"><span className="step-n">1</span>Pilih bidang Anda
        <HelpTip title="Memilih bidang Anda" demo="pilih" steps={["Klik kartu bidang yang paling mirip dengan Anda.", "Kami langsung menyiapkan layanan, jam kerja, dan fitur yang lazim dipakai bidang itu.", "Tidak ada yang cocok? Pilih “Mulai dari kosong” di bagian paling bawah.", "Semua isian masih bisa Anda ubah di langkah berikutnya."]} />
      </h2>
      <p><small>Kami menyiapkan layanan, jam kerja, atau produk awal yang cocok, baik untuk praktik pribadi maupun tempat usaha. Semuanya bisa Anda ubah.</small></p>
      {groups.map((g) => (
        <fieldset className="tpl-group" key={g}>
          <legend>{g}</legend>
          <div className="tpl-grid" role="radiogroup" aria-label={g}>
            {templates.filter((t) => t.group === g).map((t) => (
              <label className={`tpl-card${t.id === tpl ? " sel" : ""}`} key={t.id}>
                <input type="radio" name="template" value={t.id} checked={t.id === tpl} onChange={() => pick(t.id)} />
                <strong>{t.name}</strong>
                <small>{t.tagline}</small>
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      <h2 className="step"><span className="step-n">2</span>Fitur yang Anda butuhkan
        <HelpTip title="Menyalakan atau mematikan fitur" demo="fitur" steps={["Klik sakelar untuk menyalakan atau mematikan sebuah fitur.", "Fitur yang mati disembunyikan dari menu, jadi dasbor Anda tetap ringkas.", "Mematikan DP juga menyembunyikan kolom harga DP di langkah berikutnya.", "Salah pilih? Bisa diubah kapan saja di menu Pengaturan."]} />
      </h2>
      <p><small>{current.featureWhy} Nyalakan atau matikan sesuka Anda; bisa diubah lagi kapan saja di menu Pengaturan.</small></p>
      <div className="feat-list">
        {featureInfo.map((f) => (
          <label className="feat-row" key={f.key}>
            <span className="switch">
              <input type="checkbox" name={`feat-${f.key}`} checked={feat[f.key]} onChange={(e) => setOverride((o) => ({ ...o, [f.key]: e.target.checked }))} />
              <span className="track" aria-hidden="true" />
            </span>
            <span className="feat-text"><strong>{f.label}</strong><small>{f.description}</small>{!feat[f.key] && <small className="feat-off">{f.offHint}</small>}</span>
          </label>
        ))}
        <p className="feat-fixed"><small>Selalu aktif: log audit (keamanan). Pilih minimal satu: janji temu per jam atau katalog sewa.</small></p>
      </div>

      <h2 className="step"><span className="step-n">3</span>{showSchedule && feat.sewa ? "Layanan, jam kerja, dan produk sewa" : showSchedule ? "Layanan dan jam kerja" : "Produk yang disewakan"}</h2>
      <p><small>Ini titik awal untuk {current.name}. Ubah nama, harga, jumlah, tambah atau hapus sesuka Anda; bisa diubah lagi nanti di menu {showSchedule ? "Jadwal & layanan" : "Produk sewa"}. Foto produk diunggah setelah halaman dibuat.</small></p>
      <input type="hidden" name="setup" value={setup} />

      {showSchedule && (
        <>
      <div className="panel tight">
        <h3 className="h3-tip">Layanan
          <HelpTip title="Mengatur layanan" demo="layanan" steps={["Ubah nama, durasi, dan DP sesuai layanan Anda. Kosongkan DP bila gratis.", "Pilih lokasi: online, telepon, atau tatap muka.", "Klik “+ Tambah layanan” untuk layanan lain, atau “Hapus” untuk membuangnya.", "Pelanggan melihat daftar ini di halaman jadwal Anda."]} />
        </h3>
        <div className="svc-edit">
          {services.map((x, i) => (
            <div className="svc-edit-row" key={i}>
              <label className="se-title">Nama layanan<input value={x.title} onChange={(e) => patchSvc(i, { title: e.target.value })} maxLength={80} required placeholder="mis. Konsultasi awal" /></label>
              <label className="se-num">Durasi (menit)<input type="number" min={5} max={480} value={x.durationMin} onChange={(e) => patchSvc(i, { durationMin: Number(e.target.value) })} required /></label>
              {feat.pembayaran && <label className="se-num">DP (Rp)<MoneyInput value={x.depositIdr} onChange={(n) => patchSvc(i, { depositIdr: n })} placeholder="0 = gratis" /></label>}
              <label className="se-loc">Lokasi
                <select value={x.locationKind} onChange={(e) => patchSvc(i, { locationKind: e.target.value as Svc["locationKind"] })}>
                  <option value="link">Online</option><option value="phone">Telepon</option><option value="in_person">Tatap muka</option>
                </select>
              </label>
              <button type="button" className="link danger-link se-del" onClick={() => setServices((l) => l.filter((_, j) => j !== i))} aria-label={`Hapus layanan ${x.title || i + 1}`}>Hapus</button>
            </div>
          ))}
        </div>
        {services.length === 0 && <small>Belum ada layanan. Anda bisa menambahkannya nanti, tetapi pelanggan baru bisa memesan setelah ada minimal satu.</small>}
        {services.length < MAX_SERVICES && (
          <button type="button" className="btn-ghost-btn" onClick={() => setServices((l) => [...l, { title: "", durationMin: 30, depositIdr: 0, locationKind: "link" }])}>+ Tambah layanan</button>
        )}
      </div>

      <div className="panel tight">
        <h3 className="h3-tip">Jam kerja mingguan
          <HelpTip title="Mengatur jam kerja" demo="jam" steps={["Nyalakan sakelar pada hari Anda buka; hari yang mati berarti libur.", "Atur jam mulai dan selesai.", "Klik “+ jam” untuk jam istirahat, misalnya pagi dan sore.", "Cuti atau libur tanggal tertentu diatur nanti di menu Jadwal & layanan."]} />
        </h3>
        <div className="week">
          {DAYS.map(([d, name]) => {
            const rs = hours[d] ?? [];
            const on = rs.length > 0;
            return (
              <div className="week-row" key={d}>
                <label className="switch">
                  <input type="checkbox" checked={on} onChange={(e) => setHours((h) => ({ ...h, [d]: e.target.checked ? [{ start: "09:00", end: "17:00" }] : [] }))} aria-label={name} />
                  <span className="track" aria-hidden="true" />
                  <span className="day">{name}</span>
                </label>
                <span className="ranges">
                  {on ? rs.map((r, i) => (
                    <span className="times" key={i}>
                      <input type="time" value={r.start} onChange={(e) => patchRange(d, i, { start: e.target.value })} aria-label={`${name} mulai ${i + 1}`} />
                      <span aria-hidden="true">–</span>
                      <input type="time" value={r.end} onChange={(e) => patchRange(d, i, { end: e.target.value })} aria-label={`${name} selesai ${i + 1}`} />
                      {rs.length > 1 && <button type="button" className="link danger-link" onClick={() => setHours((h) => ({ ...h, [d]: (h[d] ?? []).filter((_, j) => j !== i) }))} aria-label={`Hapus jam ${name} ${i + 1}`}>×</button>}
                    </span>
                  )) : <small>Libur</small>}
                  {on && rs.length < 3 && <button type="button" className="link" onClick={() => setHours((h) => ({ ...h, [d]: [...(h[d] ?? []), { start: "13:00", end: "17:00" }] }))}>+ jam</button>}
                </span>
              </div>
            );
          })}
        </div>
        <small>Tambahkan rentang kedua untuk jam istirahat (mis. 08.00–12.00 dan 16.00–20.00).</small>
      </div>

        </>
      )}

      {feat.sewa && (
        <div className="panel tight">
          <h3 className="h3-tip">Produk sewa
            <HelpTip title="Mengatur produk sewa" demo="produk" steps={["Ketik nama produk, mis. “Toyota Avanza”.", "Isi harga per hari dan jumlah unit yang Anda punya; unit menentukan berapa orang bisa menyewa di tanggal yang sama.", "DP = bayar sebagian di depan (persen dari total) agar unit terkunci; jaminan = uang yang diserahkan saat ambil barang dan dikembalikan. Keduanya dibayar langsung ke Anda; jadwalin tidak memproses uang.", "Klik “+ Tambah produk” untuk produk lain, atau “Hapus” untuk membuangnya. Foto diunggah setelah halaman dibuat."]} />
          </h3>
          <p className="prod-how"><small><b>Cara pakai:</b> isi satu baris per produk. Harga ditulis angka saja, titik ribuan muncul otomatis. “Jumlah unit” = berapa barang yang Anda punya (mis. 2 mobil Avanza). DP dalam persen dari total sewa; isi 0 bila tidak butuh DP.</small></p>
          <div className="svc-edit">
            {products.map((x, i) => (
              <div className="svc-edit-row prod-edit-row" key={i}>
                <label className="se-title">Nama produk<input value={x.name} onChange={(e) => patchProd(i, { name: e.target.value })} maxLength={80} required placeholder="mis. Toyota Avanza" /></label>
                <label className="se-num">Harga per hari<MoneyInput value={x.pricePerDayIdr} onChange={(n) => patchProd(i, { pricePerDayIdr: n })} placeholder="450.000" required /></label>
                <label className="se-num">Jumlah unit<input inputMode="numeric" type="number" min={1} max={50} value={x.units} onChange={(e) => patchProd(i, { units: Number(e.target.value) })} /></label>
                {feat.pembayaran && <label className="se-num">DP (% dari total)<span className="pct"><input inputMode="numeric" type="number" min={0} max={100} value={x.dpPercent} onChange={(e) => patchProd(i, { dpPercent: Math.min(100, Math.max(0, Math.floor(Number(e.target.value)) || 0)) })} /><span aria-hidden="true">%</span></span></label>}
                <label className="se-num">Jaminan saat ambil<MoneyInput value={x.depositIdr} onChange={(n) => patchProd(i, { depositIdr: n })} placeholder="0" /></label>
                <button type="button" className="link danger-link se-del" onClick={() => setProducts((l) => l.filter((_, j) => j !== i))} aria-label={`Hapus produk ${x.name || i + 1}`}>Hapus</button>
              </div>
            ))}
          </div>
          {products.length === 0 && <small>Belum ada produk. Anda bisa menambahkannya nanti di menu Produk sewa.</small>}
          {products.length < 20 && (
            <button type="button" className="btn-ghost-btn" onClick={() => setProducts((l) => [...l, { name: "", category: "", description: "", pricePerDayIdr: 0, depositIdr: 0, dpPercent: 0, units: 1 }])}>+ Tambah produk</button>
          )}
        </div>
      )}

      <h2 className="step"><span className="step-n">4</span>Nama dan alamat halaman
        <HelpTip title="Nama dan alamat link" demo="nama" steps={["Ketik nama Anda atau nama tempat; alamat link terisi otomatis.", "Alamat bisa Anda ubah: huruf kecil, angka, dan tanda hubung.", "Pratinjau ponsel di kanan menunjukkan persis apa yang dilihat pelanggan.", "Klik tombol buat halaman di bawah bila sudah siap."]} />
      </h2>
      <div className="name-grid">
        <div className="name-fields">
          <label>{current.nameLabel}
            <input name="name" required minLength={2} maxLength={80} placeholder={current.example} value={name} onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(toSlug(e.target.value)); }} />
          </label>
          <label>Alamat link
            <span className="slug-input"><span className="slug-prefix" aria-hidden="true">jadwalin.id/</span>
              <input name="slug" required pattern="[a-z0-9\-]{3,32}" placeholder="nama-anda" aria-label="Alamat link setelah jadwalin.id/" value={slug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }} />
            </span>
            <small>Huruf kecil, angka, dan tanda hubung; 3–32 karakter. Inilah link yang Anda bagikan ke pelanggan.</small>
          </label>
          <label><span>Nomor WhatsApp usaha <small>· wajib; tampil ke pelanggan di tombol "Hubungi langsung"</small></span>
            <input name="contactPhone" type="tel" required inputMode="tel" autoComplete="tel" placeholder="0812…" />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="cta">{current.kind === "sewa" ? "Buat halaman sewa saya" : "Buat halaman jadwal saya"}</button>
        </div>
        <PhonePreview name={name.trim() || current.example} slug={slug || "nama-anda"} services={showSchedule ? services.filter((x) => x.title.trim()) : []} showDp={feat.pembayaran} products={feat.sewa ? products.filter((x) => x.name.trim()) : []} />
      </div>
    </form>
  );
}

const LOC_LABEL = { link: "Online", phone: "Telepon", in_person: "Tatap muka" } as const;
const idr = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

/** Pratinjau halaman publik di ponsel: bilah alamat ala browser + isi halaman yang akan dilihat pelanggan. */
function PhonePreview({ name, slug, services, showDp, products }: { name: string; slug: string; services: Svc[]; showDp: boolean; products: Prod[] }) {
  const shown = services.slice(0, 3);
  const shownProducts = products.slice(0, 3);
  return (
    <figure className="phone" aria-label="Pratinjau halaman di ponsel">
      <div className="phone-frame">
        <div className="phone-notch" aria-hidden="true" />
        <div className="phone-bar" aria-hidden="true">
          <span className="phone-url">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
            <span className="phone-url-text"><b>jadwalin.id</b>/{slug}</span>
          </span>
        </div>
        <div className="phone-screen">
          <div className="pv-hero">
            <span className="avatar xs lg" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
            <strong>{name}</strong>
            <small>{products.length > 0 && services.length === 0 ? "Pilih produk, lalu pilih tanggal sewa." : products.length > 0 ? "Pilih layanan atau produk sewa." : "Pilih layanan, lalu pilih waktu yang cocok."}</small>
          </div>
          <div className="pv-list">
            {shownProducts.map((x, i) => (
              <div className="pv-card" key={`p${i}`}>
                <strong>{x.name}</strong>
                <span className="pv-badges"><span className="dp">Rp{(Number(x.pricePerDayIdr) || 0).toLocaleString("id-ID")} / hari</span>{showDp && x.dpPercent > 0 && <span>DP {x.dpPercent}%</span>}</span>
              </div>
            ))}
            {products.length > shownProducts.length && <small className="pv-more">+ {products.length - shownProducts.length} produk lain</small>}
            {shown.map((x, i) => (
              <div className="pv-card" key={i}>
                <strong>{x.title}</strong>
                <span className="pv-badges">
                  <span>{x.durationMin} mnt</span><span>{LOC_LABEL[x.locationKind]}</span>
                  <span className={showDp && x.depositIdr > 0 ? "dp" : "free"}>{showDp && x.depositIdr > 0 ? `DP ${idr(x.depositIdr)}` : "Gratis"}</span>
                </span>
              </div>
            ))}
            {services.length > shown.length && <small className="pv-more">+ {services.length - shown.length} layanan lain</small>}
            {services.length === 0 && products.length === 0 && <small className="pv-more">Layanan atau produk Anda akan tampil di sini.</small>}
          </div>
        </div>
      </div>
      <figcaption><small>Begini tampilan halaman Anda di ponsel pelanggan.</small></figcaption>
    </figure>
  );
}
