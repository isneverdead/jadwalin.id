import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";

const sfx = Math.random().toString(36).slice(2, 8);
const PASSWORD = "e2e-kata-sandi-123";
const slug = `fitur-${sfx}`;
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

test("fitur per usaha: template menyarankan, bisa diubah saat membuat, dan Pengaturan menyalakannya kembali", async ({ browser }) => {
  const owner = await newUser(browser, "Pemilik Fitur", email("owner"));
  await owner.goto("/dashboard/bisnis-baru");
  await owner.getByText("Salon rambut", { exact: true }).click();
  // Saran untuk salon: tiket dan pembayaran mati. Pemilik menyalakan pembayaran sendiri.
  await expect(owner.getByRole("checkbox", { name: /Tiket & pesan klien/ })).not.toBeChecked();
  await owner.getByRole("checkbox", { name: /DP & pembayaran manual/ }).check();
  await expect(owner.getByRole("checkbox", { name: /DP & pembayaran manual/ })).toBeChecked();
  // Template hanya titik awal: ubah nama layanan pertama dan hapus yang kedua sebelum membuat.
  await owner.getByLabel("Nama layanan").first().fill("Potong Spesial E2E");
  await owner.getByRole("button", { name: /^Hapus layanan Creambath/ }).click();
  await owner.locator('input[name="name"]').fill("Salon Fitur E2E");
  await expect(owner.locator(".phone-url-text")).toContainText(`/${slug}`.slice(0, 1)); // pratinjau ponsel hidup
  await owner.locator('input[name="slug"]').fill(slug);
  await owner.getByRole("button", { name: "Buat halaman jadwal saya" }).click();

  await expect(owner.locator(".side-biz")).toBeVisible(); // halaman selesai dibuat
  await owner.goto(`/w/${slug}/jadwal`);
  await expect(owner.getByText("Potong Spesial E2E").first()).toBeVisible();
  await expect(owner.getByText("Creambath")).toHaveCount(0);
  await expect(owner.getByText("Pewarnaan rambut").first()).toBeVisible();
  await owner.goto(`/w/${slug}`);

  const nav = owner.getByRole("navigation", { name: "Menu usaha" });
  await expect(nav.getByRole("link", { name: "Pembayaran" })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^Tiket/ })).toHaveCount(0);

  // Halaman fitur yang dimatikan tidak 404: ada jalan untuk menyalakannya.
  await owner.goto(`/w/${slug}/tiket`);
  await expect(owner.getByText("Fitur ini sedang dimatikan untuk usaha ini.")).toBeVisible();
  // Halaman publik tidak menawarkan "Kirim pesan" selama tiket mati.
  await owner.goto(`/${slug}`);
  await expect(owner.getByRole("heading", { name: "Kirim pesan" })).toHaveCount(0);

  await owner.goto(`/w/${slug}/pengaturan`);
  await owner.getByRole("checkbox", { name: /Tiket & pesan klien/ }).check();
  await owner.getByRole("button", { name: "Simpan pengaturan" }).click();
  await expect(owner.getByText("Pengaturan tersimpan.")).toBeVisible();
  await expect(owner.getByRole("navigation", { name: "Menu usaha" }).getByRole("link", { name: /^Tiket/ })).toBeVisible();

  // Mematikan pembayaran ditolak selama masih ada layanan aktif ber-DP (salon punya "Pewarnaan rambut" DP).
  await owner.getByRole("checkbox", { name: /DP & pembayaran manual/ }).uncheck();
  await owner.getByRole("button", { name: "Simpan pengaturan" }).click();
  await expect(owner.locator("p.error")).toContainText("layanan aktif masih memakai DP");
});

test("hapus usaha: wajib ketik nama; setelah dihapus hilang dari dasbor dan halaman publik, link bebas dipakai lagi", async ({ browser }) => {
  const hslug = `hapus-${sfx}`;
  const owner = await newUser(browser, "Pemilik Hapus", email("hapus"));
  await owner.goto("/dashboard/bisnis-baru");
  await owner.getByText("Salon rambut", { exact: true }).click();
  await owner.locator('input[name="name"]').fill("Salon Dihapus");
  await owner.locator('input[name="slug"]').fill(hslug);
  await owner.getByRole("button", { name: "Buat halaman jadwal saya" }).click();
  await expect(owner.locator(".side-biz")).toBeVisible();

  await owner.goto(`/w/${hslug}/pengaturan`);
  await owner.getByLabel(/Ketik/).fill("nama salah");
  await owner.getByRole("button", { name: "Hapus usaha ini" }).click();
  await expect(owner.locator("p.error")).toContainText("Nama yang diketik tidak sama");

  await owner.getByLabel(/Ketik/).fill("Salon Dihapus");
  await owner.getByRole("button", { name: "Hapus usaha ini" }).click();
  await expect(owner.getByText("Usaha sudah dihapus.")).toBeVisible();
  await expect(owner.getByText("Salon Dihapus")).toHaveCount(0);

  // Halaman publik dan dasbor lamanya tidak lagi ada; link boleh dipakai lagi.
  expect((await owner.request.get(`/${hslug}`)).status()).toBe(404);
  expect((await owner.request.get(`/w/${hslug}`)).status()).toBe(404);
  await owner.goto("/dashboard/bisnis-baru");
  await owner.getByText("Salon rambut", { exact: true }).click();
  await owner.locator('input[name="name"]').fill("Salon Baru");
  await owner.locator('input[name="slug"]').fill(hslug);
  await owner.getByRole("button", { name: "Buat halaman jadwal saya" }).click();
  await expect(owner.locator(".side-biz")).toBeVisible();
});
