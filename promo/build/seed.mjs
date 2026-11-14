// Seeds a realistic demo workspace through the real UI (no app code touched). Run: node promo/build/seed.mjs
import { chromium, expect } from "/Users/fariz/Documents/PORTFOLIO/Jadwalin.id/apps/web/node_modules/@playwright/test/index.mjs";
import pg from "/Users/fariz/Documents/PORTFOLIO/Jadwalin.id/apps/web/node_modules/pg/lib/index.js";
import fs from "node:fs";

const BASE = "http://localhost:3000";
const SLUG = "demo-pajak-rahayu";
const PASSWORD = "Demo-Kantor-Rahayu-2026!";
const STATE = "/Users/fariz/Documents/PORTFOLIO/Jadwalin.id/promo/build/state";
const pool = new pg.Pool({ connectionString: "postgres://jadwalin:jadwalin@localhost:5433/jadwalin" });
const users = {
  owner: ["Rahayu Wulandari", "rahayu@kantorrahayu.id"],
  staf: ["Bagas Pratama", "bagas@kantorrahayu.id"],
  dewi: ["Dewi Lestari", "dewi.lestari@gmail.com"],
  hendra: ["Hendra Kusuma", "hendra.kusuma@outlook.com"],
};
if ((await pool.query("select 1 from workspaces where slug=$1", [SLUG])).rowCount) throw new Error("demo workspace sudah ada");
for (const [, e] of Object.values(users)) if ((await pool.query("select 1 from users where email=$1", [e])).rowCount) throw new Error("email sudah ada " + e);

const browser = await chromium.launch();
async function emailLink(to, template, re) {
  for (let i = 0; i < 40; i++) {
    const r = await pool.query("select payload from notification_outbox where recipient=$1 and template=$2 order by created_at desc limit 1", [to, template]);
    const u = r.rows[0]?.payload?.url; if (u && re.test(u)) return u;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("tautan tidak ada " + to);
}
async function newUser(key) {
  const [name, mail] = users[key];
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
  // browser upload ke S3 dev lintas-origin: relay lewat Node supaya tak terganjal CORS bucket
  await ctx.route("http://localhost:9100/**", async (route) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const res = await route.fetch(); await route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
  });
  const page = await ctx.newPage();
  await page.goto("/daftar");
  await page.getByLabel("Nama", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill(mail);
  await page.getByLabel(/^Kata sandi/).fill(PASSWORD);
  await page.getByRole("button", { name: "Daftar" }).click();
  await expect(page.getByRole("heading", { name: "Cek email Anda" })).toBeVisible();
  await page.goto(await emailLink(mail, "verify_email", /verify-email/));
  await expect(page.getByRole("heading", { name: new RegExp(`Halo, ${name}`) })).toBeVisible();
  return page;
}
async function settle(page, name) {
  await Promise.all([page.waitForResponse((r) => r.request().method() === "POST"), page.getByRole("button", { name }).click()]);
  await page.waitForLoadState("networkidle");
}
async function send(page, text, internal = false) {
  await page.getByLabel("Balas").fill(text);
  if (internal) await page.getByLabel(/Catatan internal/).check();
  await page.getByRole("button", { name: "Kirim", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(text.split("\n")[0])).toBeVisible();
}
async function openTicket(klien, title, body) {
  await klien.goto(`/${SLUG}`);
  await klien.getByRole("button", { name: /Kirim pesan/ }).click();
  await klien.getByLabel(/^Judul/).fill(title);
  await klien.getByLabel(/^Ceritakan/).fill(body);
  await klien.getByRole("button", { name: "Kirim", exact: true }).click();
  await expect(klien.getByRole("heading", { name: new RegExp(title.slice(0, 20)) })).toBeVisible();
  return klien.url();
}

// ---- Pemilik
const owner = await newUser("owner");
await owner.getByLabel("Nama bisnis").fill("Kantor Konsultan Pajak Rahayu");
await owner.getByLabel(/^Nama link/).fill(SLUG);
await owner.getByRole("button", { name: "Buat workspace" }).click();
await expect(owner.getByRole("heading", { name: "Kantor Konsultan Pajak Rahayu" })).toBeVisible();
await owner.getByLabel("Email", { exact: true }).fill(users.staf[1]);
await owner.getByRole("button", { name: "Kirim undangan" }).click();
await expect(owner.getByText(users.staf[1])).toBeVisible();

// jam rutin pemilik: Senin–Jumat 09:00–16:00, Sabtu 09:00–12:00
await owner.goto(`/w/${SLUG}/jadwal`);
const D = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];
async function weekly(page, hours) {
  for (const [i, d] of D.entries()) {
    const h = hours[i]; const cb = page.getByLabel(d, { exact: true });
    if (h) { await cb.check(); await page.getByLabel(`${d} mulai`).fill(h[0]); await page.getByLabel(`${d} selesai`).fill(h[1]); } else await cb.uncheck();
  }
  await settle(page, "Simpan jam rutin");
}
await weekly(owner, [["09:00","16:00"],["09:00","16:00"],["09:00","16:00"],["09:00","16:00"],["09:00","16:00"],["09:00","12:00"],null]);

async function addType(t) {
  await owner.getByLabel("Judul").fill(t.title);
  await owner.getByLabel("Kode (untuk link)").fill(t.code);
  await owner.getByLabel(/^Durasi/).fill(String(t.dur));
  await owner.getByLabel(/^Interval slot/).fill(String(t.step));
  await owner.getByLabel(/^Buffer sesudah/).fill(String(t.buf));
  await owner.getByLabel(/^Pemberitahuan minimum/).fill("120");
  await owner.getByLabel("Link / nomor / alamat").fill(t.loc);
  if (t.kind) await owner.locator('select[name="locationKind"]').selectOption(t.kind);
  await settle(owner, "Tambah jenis pertemuan");
  await expect(owner.getByText(`jadwalin.id/${SLUG}/${t.code}`)).toBeVisible();
}
await addType({ title: "Konsultasi Pajak 30 Menit", code: "konsultasi", dur: 30, step: 30, buf: 10, loc: "https://meet.google.com/pjk-rhy-konsul" });
await addType({ title: "Review SPT Tahunan 60 Menit", code: "review-spt", dur: 60, step: 60, buf: 15, loc: "https://meet.google.com/pjk-rhy-review" });
await addType({ title: "Konsultasi Tatap Muka di Kantor", code: "tatap-muka", dur: 45, step: 45, buf: 15, loc: "Jl. Cikini Raya No. 12, Menteng, Jakarta Pusat", kind: "in_person" });
// satu libur contoh
const d = new Date(Date.now() + 12 * 864e5); const iso = d.toISOString().slice(0, 10);
await owner.getByLabel("Tanggal").fill(iso);
await settle(owner, "Tambah pengecualian");

// ---- Staf
const staf = await newUser("staf");
await staf.goto(await emailLink(users.staf[1], "workspace_invite", /\/undangan\//));
await staf.getByRole("button", { name: "Terima undangan" }).click();
await expect(staf.getByText("peran Anda: staff")).toBeVisible();
await staf.goto(`/w/${SLUG}/jadwal`);
await weekly(staf, [["10:00","17:00"],["10:00","17:00"],["10:00","17:00"],["10:00","17:00"],["10:00","15:00"],null,null]);
// Bagas ikut melayani "Konsultasi Pajak 30 Menit" (slot gabungan)
await owner.goto(`/w/${SLUG}/jadwal`);
const card = owner.locator(".card", { hasText: "Konsultasi Pajak 30 Menit" }).first();
await card.getByLabel("Bagas Pratama").check();
await Promise.all([owner.waitForResponse((r) => r.request().method() === "POST"), card.getByRole("button", { name: "Simpan host" }).click()]);
await owner.waitForLoadState("networkidle");

// ---- Klien Dewi: tiket SPT
const dewi = await newUser("dewi");
const dewiUrl = await openTicket(dewi, "Konsultasi SPT Tahunan Badan CV Sinar Pagi", "Selamat pagi Bu Rahayu,\nKami CV Sinar Pagi (usaha percetakan, omzet sekitar Rp1,8 miliar tahun 2025). Mohon dibantu menyusun SPT Tahunan Badan, terutama rekonsiliasi fiskal dan pembukuan yang belum rapi.\nKapan kami bisa berkonsultasi?");
// ---- Klien Hendra: dua tiket
const hendra = await newUser("hendra");
const hendraUrl = await openTicket(hendra, "Tanya PPh final UMKM 0,5% untuk toko online", "Halo, saya berjualan di marketplace dengan omzet sekitar Rp40 juta per bulan. Apakah saya wajib lapor dan setor PPh final 0,5% setiap bulan? Terima kasih.");
await openTicket(hendra, "Bantuan pembukuan sederhana untuk toko online", "Saya belum punya pembukuan sama sekali. Bisakah dibantu template pencatatan yang sesuai untuk UMKM?");

// ---- Staf menangani tiket Dewi
await staf.goto(`/w/${SLUG}/tiket`);
await staf.getByRole("link", { name: /Konsultasi SPT Tahunan Badan/ }).click();
await expect(staf.getByRole("heading", { name: /Konsultasi SPT Tahunan Badan/ })).toBeVisible();
await staf.getByLabel("Penanggung jawab").selectOption({ label: "Bagas Pratama" });
await settle(staf, "Tugaskan");
await expect(staf.getByText("ditangani Bagas Pratama")).toBeVisible();
await staf.getByLabel("Status", { exact: true }).selectOption({ label: "Diproses" });
await settle(staf, "Ubah status");
await send(staf, "Klien ini punya selisih penyusutan aset tahun 2024; cek dulu rekonsiliasi fiskal sebelum meeting. Tarif pengenaan perlu dikonfirmasi ke Bu Rahayu.", true);
await send(staf, "Selamat pagi Bu Dewi, terima kasih sudah menghubungi kami. Kami bantu ya. Mohon kirimkan laporan laba rugi dan neraca 2025 serta daftar aset tetap, nanti kami siapkan jadwal konsultasi online.");
await staf.getByLabel(/^Berkas/).setInputFiles({ name: "Checklist-Dokumen-SPT-Badan-2025.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 checklist") });
await staf.getByLabel(/^Catatan konteks/).fill("Daftar dokumen yang perlu disiapkan sebelum konsultasi");
await settle(staf, "Lampirkan");
await expect(staf.getByRole("link", { name: "Checklist-Dokumen-SPT-Badan-2025.pdf" })).toBeVisible();
await staf.reload();
await staf.getByLabel(/^Jadwalkan/).selectOption({ index: 0 });
await settle(staf, /Jadwalkan & beri tahu klien/);
await expect(staf.getByText(/terjadwal · Bagas Pratama/)).toBeVisible();

// Dewi membalas
await dewi.goto(dewiUrl);
await send(dewi, "Terima kasih Pak Bagas. Dokumen sudah saya siapkan, akan saya unggah hari ini. Meeting-nya saya ikuti ya.");
// ada lampiran dari klien
await dewi.getByLabel(/^Berkas/).setInputFiles({ name: "Laporan-Keuangan-CV-Sinar-Pagi-2025.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 lapkeu") });
const ctxNote = dewi.getByLabel(/^Catatan konteks/); if (await ctxNote.count()) await ctxNote.fill("Laba rugi dan neraca per 31 Desember 2025");
await settle(dewi, "Lampirkan");

// Hendra: staf menjawab, status Diproses untuk tiket pertama
await staf.goto(`/w/${SLUG}/tiket`);
await staf.getByRole("link", { name: /Tanya PPh final UMKM/ }).click();
await staf.getByLabel("Penanggung jawab").selectOption({ label: "Rahayu Wulandari" });
await settle(staf, "Tugaskan");
await staf.getByLabel("Status", { exact: true }).selectOption({ label: "Diproses" });
await settle(staf, "Ubah status");
await send(staf, "Halo Pak Hendra. Untuk omzet di bawah Rp500 juta per tahun, penghasilan tidak kena pajak; di atasnya PPh final 0,5% dari omzet bruto. Kami cek dulu omzet kumulatif Bapak, ya.");

// ---- Booking publik oleh tamu
const guestCtx = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 } });
const g = await guestCtx.newPage();
await g.goto(`/${SLUG}/konsultasi`);
const first = (await g.locator('select[name="startsAt"] option:not([disabled])').evaluateAll((els) => els.map((e) => e.value)))[7];
await g.locator('select[name="startsAt"]').selectOption(first);
await g.getByLabel("Nama", { exact: true }).fill("Budi Santoso");
await g.getByLabel(/^Email/).fill("budi.santoso.id@gmail.com");
await g.getByLabel(/^Nomor HP/).fill("0812-3456-7890");
await g.getByLabel("Topik").fill("Pelaporan PPN usaha katering");
await g.getByLabel(/^Catatan/).fill("Mohon dibahas cara membuat faktur pajak untuk pelanggan perusahaan.");
await expect(g.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 30000 });
await g.getByRole("button", { name: "Pesan jadwal" }).click();
await expect(g.getByRole("heading", { name: "Booking terkonfirmasi" })).toBeVisible();
const manage = g.url().split("?")[0];

fs.writeFileSync(`${STATE}/seed.json`, JSON.stringify({ SLUG, PASSWORD, users, dewiUrl, hendraUrl, manage }, null, 2));
for (const [k, p] of Object.entries({ owner, staf, dewi, hendra })) await p.context().storageState({ path: `${STATE}/${k}.json` });
await browser.close(); await pool.end();
console.log("OK", manage);
