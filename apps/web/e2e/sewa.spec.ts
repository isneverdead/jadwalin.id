import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";

const sfx = Math.random().toString(36).slice(2, 8);
const PASSWORD = "e2e-kata-sandi-123";
const slug = `sewa-${sfx}`;
const email = (k: string) => `${k}-${sfx}@e2e.local`;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// Pembatas pendaftaran (10/jam/IP) tersimpan di DB; kosongkan agar E2E bisa diulang dari IP yang sama.
test.beforeAll(async () => {
  await pool.query("DELETE FROM rate_limits");
});
test.afterAll(async () => pool.end());

/** Tautan email dibaca dari outbox (payload baru dihapus setelah worker mengirim). */
async function emailLink(to: string, template: string, pattern: RegExp): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const r = await pool.query(`SELECT payload FROM notification_outbox WHERE recipient = $1 AND template = $2 ORDER BY created_at DESC LIMIT 1`, [to, template]);
    const url = r.rows[0]?.payload?.url as string | undefined;
    if (url && pattern.test(url)) return url;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Tautan ${template} untuk ${to} tidak ditemukan. Pastikan worker tidak berjalan.`);
}

async function register(page: Page, name: string, mail: string) {
  await page.goto("/daftar");
  await page.getByLabel("Nama", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill(mail);
  await page.getByLabel(/^Kata sandi/).fill(PASSWORD);
  await page.getByLabel(/Saya menyetujui/).check();
  await page.getByRole("button", { name: "Daftar" }).click();
  await expect(page.getByRole("heading", { name: "Cek email Anda" })).toBeVisible();
  // Klik tautan verifikasi seperti penerima email: otomatis masuk.
  await page.goto(await emailLink(mail, "verify_email", /verify-email/));
  await expect(page.getByRole("heading", { name: new RegExp(`Halo, ${name}`) })).toBeVisible();
}


async function newUser(browser: Browser, name: string, mail: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await register(page, name, mail);
  return page;
}

// PNG 1x1 valid (foto produk uji).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("sewa barang: template rental, foto produk, tamu memesan tanggal, pemilik mengonfirmasi, tamu membatalkan", async ({ browser }) => {
  const owner = await newUser(browser, "Pemilik Rental", email("owner"));
  await owner.goto("/dashboard/bisnis-baru");
  await owner.getByText("Rental motor / skuter", { exact: true }).click();
  await owner.locator('input[name="name"]').fill("Rental Motor E2E");
  await owner.locator('input[name="slug"]').fill(slug);
  await owner.getByRole("button", { name: "Buat halaman sewa saya" }).click();
  await expect(owner.locator(".side-biz")).toBeVisible();

  // Usaha sewa: menu sewa muncul; "Jadwal & layanan" (janji temu per jam) TIDAK ada; tiket mati menurut template.
  const nav = owner.getByRole("navigation", { name: "Menu usaha" });
  await expect(nav.getByRole("link", { name: "Jadwal & layanan" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Produk sewa" })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^Pesanan sewa/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^Tiket/ })).toHaveCount(0);

  // Produk contoh terpasang; unggah foto untuk produk pertama (jalur sendiri, tanpa fitur Berkas).
  await owner.goto(`/w/${slug}/produk`);
  await expect(owner.getByText("Honda Beat").first()).toBeVisible();
  await owner.locator(".prod-card").first().getByText("Ubah produk").click();
  await owner.locator(".prod-card").first().locator('input[type="file"]').setInputFiles({ name: "motor.png", mimeType: "image/png", buffer: PNG });
  await expect(owner.getByText("Foto siap disimpan.")).toBeVisible();
  await owner.locator(".prod-card").first().getByRole("button", { name: "Simpan perubahan" }).click();
  await expect(owner.getByText("Perubahan tersimpan.")).toBeVisible();

  // Pemilik mengatur metode pembayaran (DP 30% sudah bawaan template rental).
  await owner.goto(`/w/${slug}/pembayaran`);
  await owner.getByLabel("Nama metode").fill("BCA");
  await owner.getByLabel("Atas nama").fill("Rental Motor E2E");
  await owner.getByLabel(/^Nomor rekening/).fill("1234567890");
  await owner.getByRole("button", { name: "Simpan metode" }).click();
  await expect(owner.getByText("BCA", { exact: true }).first()).toBeVisible();

  // Tamu (tanpa akun) membuka katalog publik, memilih tanggal, dan mengajukan sewa.
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(`/${slug}`);
  await expect(guest.getByRole("heading", { name: "Rental Motor E2E" })).toBeVisible();
  const firstImg = guest.locator(".prod-link img").first();
  await expect(firstImg).toBeVisible();
  await expect.poll(() => firstImg.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0); // foto tersaji lewat URL bertanda tangan
  await guest.getByRole("link", { name: /Honda Beat/ }).click();
  const days = guest.locator(".cal-day.has");
  await days.nth(2).click();
  await days.nth(3).click();
  await expect(guest.locator(".rp-total")).toContainText("2 hari");
  await guest.getByLabel("Nama", { exact: true }).fill("Penyewa E2E");
  await guest.getByLabel(/^Nomor HP/).fill("081234567890");
  await guest.getByLabel(/Saya telah membaca/).check();
  await expect(guest.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 30_000 }); // Turnstile (kunci uji) selesai
  await guest.getByRole("button", { name: "Lanjut ke pembayaran DP" }).click();
  await expect(guest.getByRole("heading", { name: "Permintaan sewa terkirim" })).toBeVisible();
  await expect(guest.getByText("Selesaikan DP.")).toBeVisible();
  await expect(guest.getByText("1234567890")).toBeVisible(); // metode bayar tampil untuk pelanggan
  const orderUrl = guest.url().split("?")[0]!;
  // Pelanggan mengunggah bukti DP; status berubah menjadi menunggu verifikasi.
  await guest.locator('input[type="file"]').setInputFiles({ name: "bukti.png", mimeType: "image/png", buffer: PNG });
  await guest.getByRole("button", { name: "Kirim bukti pembayaran" }).click();
  await expect(guest.getByText("Bukti DP diterima.")).toBeVisible({ timeout: 30_000 });

  // Pemilik: pesanan menunggu DP (tombol konfirmasi biasa tidak ada), lalu menandai DP lunas di menu Pembayaran.
  await owner.goto(`/w/${slug}/sewa`);
  await expect(owner.getByText("Penyewa E2E")).toBeVisible();
  await expect(owner.getByText("Bukti DP menunggu verifikasi")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Konfirmasi" })).toHaveCount(0);
  await owner.goto(`/w/${slug}/pembayaran`);
  await expect(owner.locator(".proof-img")).toBeVisible(); // pratinjau bukti langsung
  await owner.getByRole("button", { name: "Konfirmasi lunas" }).click();
  await expect(owner.getByRole("button", { name: "Konfirmasi lunas" })).toHaveCount(0); // aksi selesai
  await owner.goto(`/w/${slug}/sewa`);
  await expect(owner.getByText("Dikonfirmasi")).toBeVisible();
  await expect(owner.getByText("DP lunas")).toBeVisible();
  await guest.goto(orderUrl);
  await expect(guest.getByText("Pesanan dikonfirmasi.")).toBeVisible();

  // Tamu membatalkan; unit bebas lagi dan pemilik melihatnya sebagai dibatalkan.
  await guest.getByRole("button", { name: "Batalkan pesanan" }).click();
  await guest.getByRole("button", { name: "Ya, lanjutkan" }).click(); // dialog konfirmasi di dalam halaman
  await expect(guest.getByText("Pesanan dibatalkan.")).toBeVisible();
  await owner.goto(`/w/${slug}/sewa?semua=1`);
  await expect(owner.getByText("Dibatalkan")).toBeVisible();

  // Katalog tidak bisa dimatikan sendirian: halaman butuh minimal satu mode (jadwal/sewa).
  await owner.goto(`/w/${slug}/pengaturan`);
  await owner.getByRole("checkbox", { name: /Katalog produk & sewa barang/ }).uncheck();
  await owner.getByRole("button", { name: "Simpan pengaturan" }).click();
  await expect(owner.locator("p.error")).toContainText("Aktifkan minimal satu");
  // Dengan janji temu per jam dinyalakan, katalog boleh dimatikan (pesanan sudah dibatalkan).
  await owner.getByRole("checkbox", { name: /Janji temu per jam/ }).check();
  await owner.getByRole("checkbox", { name: /Katalog produk & sewa barang/ }).uncheck();
  await owner.getByRole("button", { name: "Simpan pengaturan" }).click();
  await expect(owner.getByText("Pengaturan tersimpan.")).toBeVisible();
  await guest.goto(`/${slug}`);
  await expect(guest.getByText("Katalog sewa")).toHaveCount(0);
});
