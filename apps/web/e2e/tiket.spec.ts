import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";

const sfx = Math.random().toString(36).slice(2, 8);
const PASSWORD = "e2e-kata-sandi-123";
const slug = `e2e-${sfx}`;
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


/** Klik tombol lalu tunggu respons server action + render ulang selesai (hindari balapan dengan isian berikutnya). */
async function clickAndSettle(page: Page, name: string | RegExp) {
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    page.getByRole("button", { name }).click(),
  ]);
  await page.waitForLoadState("networkidle");
}

async function newUser(browser: Browser, name: string, mail: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await register(page, name, mail);
  return page;
}

test("klien membuka tiket → staf menangani → lampiran → meeting → klien menutup", async ({ browser }) => {
  // ===== Pemilik: workspace, undang staf, jenis pertemuan =====
  const owner = await newUser(browser, "Pemilik E2E", email("owner"));
  await owner.goto("/dashboard/bisnis-baru");
  await owner.getByText("Mulai dari kosong", { exact: true }).click();
  await owner.locator('input[name="name"]').fill("Praktik E2E");
  await owner.locator('input[name="slug"]').fill(slug);
  await owner.locator('input[name="contactPhone"]').fill("081255500000");
  await owner.getByRole("button", { name: "Buat halaman jadwal saya" }).click();
  await expect(owner.locator(".side-biz").getByText("Praktik E2E")).toBeVisible();

  await owner.getByText("+ Undang anggota baru").click();
  await owner.getByLabel("Email", { exact: true }).fill(email("staf"));
  await owner.getByRole("button", { name: "Kirim undangan" }).click();
  await expect(owner.getByText(email("staf"))).toBeVisible(); // muncul di "Undangan tertunda"

  await owner.goto(`/w/${slug}/jadwal`);
  await owner.getByText("+ Tambah layanan baru").click();
  await owner.getByLabel("Nama layanan").last().fill("Konsultasi E2E");
  await owner.getByLabel("Kode untuk link").fill("konsultasi");
  await owner.getByLabel("Link / nomor / alamat").last().fill("https://meet.example.com/e2e-ruang");
  await clickAndSettle(owner, "Tambah layanan");
  await expect(owner.getByText("Konsultasi E2E").first()).toBeVisible();

  // ===== Staf: daftar, terima undangan, atur ketersediaan =====
  const staf = await newUser(browser, "Staf E2E", email("staf"));
  await staf.goto(await emailLink(email("staf"), "workspace_invite", /\/undangan\//));
  await staf.getByRole("button", { name: "Terima undangan" }).click();
  await expect(staf.locator(".side-biz").getByText("Staf")).toBeVisible();

  await staf.goto(`/w/${slug}/jadwal`);
  for (const day of ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"]) {
    await staf.getByLabel(day, { exact: true }).check();
  }
  await clickAndSettle(staf, "Simpan jam kerja");
  await expect(staf.getByText("Pratinjau slot tersedia")).toBeVisible();

  // ===== Klien: daftar lalu buka tiket lewat halaman publik =====
  const klien = await newUser(browser, "Klien E2E", email("klien"));
  await klien.goto(`/${slug}`);
  await expect(klien.getByRole("heading", { name: "Praktik E2E" })).toBeVisible();
  await klien.getByRole("button", { name: /Kirim pesan/ }).click();
  await klien.getByLabel(/^Judul/).fill("Butuh konsultasi SPT tahunan");
  await klien.getByLabel(/^Ceritakan/).fill("Mohon dibantu mengisi SPT.\nBaris kedua.");
  await klien.getByRole("button", { name: "Kirim", exact: true }).click();
  await expect(klien.getByRole("heading", { name: /#1 Butuh konsultasi SPT tahunan/ })).toBeVisible();
  const clientTicketUrl = klien.url();

  // ===== Staf: ambil tiket, catatan internal, balasan publik =====
  await staf.goto(`/w/${slug}/tiket`);
  await staf.getByRole("link", { name: /#1 Butuh konsultasi SPT tahunan/ }).click();
  await expect(staf.getByRole("heading", { name: /#1 Butuh konsultasi SPT tahunan/ })).toBeVisible(); // tunggu navigasi selesai
  await staf.getByLabel("Penanggung jawab").selectOption({ label: "Staf E2E" });
  await staf.getByRole("button", { name: "Tugaskan" }).click();
  await expect(staf.getByText("ditangani Staf E2E")).toBeVisible();
  await staf.getByLabel("Status", { exact: true }).selectOption({ label: "Diproses" });
  await staf.getByRole("button", { name: "Ubah status" }).click();
  await expect(staf.locator(".page-head .badge").getByText("Diproses", { exact: true })).toBeVisible();

  const SECRET = "CATATAN-INTERNAL-E2E-RAHASIA";
  await staf.getByLabel("Balas").fill(SECRET);
  await staf.getByLabel(/Catatan internal/).check();
  await staf.getByRole("button", { name: "Kirim", exact: true }).click();
  await expect(staf.getByText(/CATATAN INTERNAL/)).toBeVisible();

  await staf.getByLabel("Balas").fill("Baik, kami bantu. Mohon kirim dokumen pendukungnya.");
  await staf.getByRole("button", { name: "Kirim", exact: true }).click();
  await expect(staf.getByText("Mohon kirim dokumen pendukungnya.")).toBeVisible();

  // ===== Klien melihat balasan publik, TIDAK melihat catatan internal =====
  await klien.goto(clientTicketUrl);
  await expect(klien.getByText("Mohon kirim dokumen pendukungnya.")).toBeVisible();
  await expect(klien.getByText(SECRET)).toHaveCount(0);
  await expect(klien.getByText(/CATATAN INTERNAL/)).toHaveCount(0);
  expect(await klien.content()).not.toContain(SECRET);

  // ===== Lampiran: staf (dengan konteks) dan satu yang disembunyikan; klien hanya melihat yang terbuka =====
  const pdf = (text: string) => ({ name: "", mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4 ${text}`) });
  await staf.getByLabel(/^Berkas/).setInputFiles({ ...pdf("panduan"), name: "panduan-spt.pdf" });
  await staf.getByLabel(/^Catatan konteks/).fill("Contoh pengisian SPT 1770");
  await staf.getByRole("button", { name: "Lampirkan" }).click();
  await expect(staf.getByRole("link", { name: "panduan-spt.pdf" })).toBeVisible();

  await staf.getByLabel(/^Berkas/).setInputFiles({ ...pdf("internal"), name: "analisis-internal.pdf" });
  await staf.getByLabel(/^Catatan konteks/).fill("Strategi internal");
  await staf.getByLabel(/Sembunyikan dari klien/).check();
  await staf.getByRole("button", { name: "Lampirkan" }).click();
  await expect(staf.getByRole("link", { name: "analisis-internal.pdf" })).toBeVisible();
  await expect(staf.getByText("tersembunyi dari klien")).toBeVisible();

  await klien.goto(clientTicketUrl);
  await expect(klien.getByRole("link", { name: "panduan-spt.pdf" })).toBeVisible();
  await expect(klien.getByText("Contoh pengisian SPT 1770")).toBeVisible();
  await expect(klien.getByText("analisis-internal.pdf")).toHaveCount(0);
  await expect(klien.getByText("Strategi internal")).toHaveCount(0);

  // Klien mengunduh lampiran: dialihkan ke URL penyimpanan ber-tanda-tangan, isi utuh.
  const href = await klien.getByRole("link", { name: "panduan-spt.pdf" }).getAttribute("href");
  const dl = await klien.request.get(href!);
  expect(dl.status()).toBe(200);
  expect((await dl.body()).toString()).toContain("%PDF-1.4 panduan");
  // Lampiran tersembunyi tidak bisa diunduh klien walau id-nya ditebak/diketahui.
  const hiddenId = (await pool.query(`SELECT ta.id FROM ticket_attachments ta WHERE NOT ta.client_visible AND ta.workspace_id = (SELECT id FROM workspaces WHERE slug = $1)`, [slug])).rows[0].id;
  const blocked = await klien.request.get(href!.replace(/[0-9a-f-]{36}$/, hiddenId));
  expect(blocked.status()).toBe(404);

  // ===== Staf menjadwalkan meeting dari tiket; klien melihatnya =====
  await staf.reload();
  await staf.getByLabel(/^Jadwalkan/).selectOption({ index: 0 });
  await staf.getByRole("button", { name: /Jadwalkan & beri tahu klien/ }).click();
  await expect(staf.getByText("terjadwal · Staf E2E")).toBeVisible();

  await klien.goto(clientTicketUrl);
  await expect(klien.getByText("Konsultasi E2E —")).toBeVisible();
  await expect(klien.getByRole("link", { name: "https://meet.example.com/e2e-ruang" })).toBeVisible();

  // ===== Klien membalas dan menutup tiketnya =====
  await klien.getByLabel("Balas").fill("Terima kasih, dokumen sudah saya terima.");
  await klien.getByRole("button", { name: "Kirim", exact: true }).click();
  await expect(klien.getByText("Terima kasih, dokumen sudah saya terima.")).toBeVisible();
  await klien.getByRole("button", { name: "Tutup tiket ini" }).click();
  await expect(klien.getByText("Status: Ditutup")).toBeVisible();
  await expect(klien.getByLabel("Balas")).toHaveCount(0); // tiket ditutup

  // ===== Staf melihat hasil akhir =====
  await staf.reload();
  await expect(staf.getByText("Terima kasih, dokumen sudah saya terima.")).toBeVisible();
  await expect(staf.locator(".page-head .badge").getByText("Ditutup", { exact: true })).toBeVisible();

  // ===== Riwayat lengkap di database + email notifikasi antre =====
  const ws = (await pool.query(`SELECT id FROM workspaces WHERE slug = $1`, [slug])).rows[0].id;
  const events = (await pool.query(`SELECT kind, to_value FROM ticket_events WHERE workspace_id = $1 ORDER BY created_at`, [ws])).rows;
  expect(events.map((e) => e.kind)).toEqual(["created", "assign", "status", "attachment", "attachment", "meeting", "status"]);
  expect(events.at(-1)).toMatchObject({ kind: "status", to_value: "closed" });

  const mails = (await pool.query(`SELECT recipient, payload->>'subject' AS subject FROM notification_outbox WHERE workspace_id = $1 AND template = 'generic_notice'`, [ws])).rows;
  const to = (r: string) => mails.filter((m) => m.recipient === r).map((m) => m.subject);
  expect(to(email("owner")).some((s) => s.startsWith("Tiket baru #1"))).toBe(true); // tiket baru → owner/admin (belum ada penanggung jawab)
  expect(to(email("klien")).some((s) => s.startsWith("Balasan untuk tiket #1"))).toBe(true);
  expect(to(email("klien")).some((s) => s.startsWith("Meeting dijadwalkan"))).toBe(true);
  expect(to(email("staf")).some((s) => s.startsWith("Balasan klien pada tiket #1"))).toBe(true); // ke penanggung jawab
  expect(JSON.stringify(mails)).not.toContain(SECRET); // catatan internal tak pernah diemailkan
});
