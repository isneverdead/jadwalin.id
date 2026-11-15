import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";

const sfx = Math.random().toString(36).slice(2, 8);
const PASSWORD = "e2e-kata-sandi-123";
const slug = `bk-${sfx}`;
const email = (k: string) => `${k}-${sfx}@e2e.local`;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
test.beforeAll(async () => {
  await pool.query("DELETE FROM rate_limits"); // pembatas pendaftaran (10/jam/IP) tersimpan di DB
  await pool.query("DELETE FROM rate_counters");
  await pool.query("DELETE FROM job_status WHERE job = 'worker_heartbeat'"); // kesiapan harus melaporkan worker yang tak berjalan
});
test.afterAll(async () => pool.end());

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

/** Pelanggaran CSP yang muncul di konsol halaman mana pun selama alur berjalan. */
const cspViolations: string[] = [];

async function newPage(browser: Browser) {
  const page = await (await browser.newContext()).newPage();
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (load|execute|connect|frame)/i.test(m.text())) cspViolations.push(m.text().slice(0, 200));
  });
  return page;
}

/** Nilai semua opsi slot yang ditawarkan halaman publik. */
async function offered(page: Page): Promise<string[]> {
  const raw = (await page.locator(".picker").getAttribute("data-slots")) ?? "";
  return raw ? raw.split(",") : [];
}

/** Memilih slot lewat kalender seperti pengguna: ganti bulan bila perlu, klik tanggal, klik jam (zona WIB). */
async function chooseSlot(page: Page, iso: string) {
  const local = new Date(Date.parse(iso) + 7 * 3600_000);
  const day = String(local.getUTCDate());
  const time = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  const dayBtn = page.locator(".cal-day.has", { hasText: new RegExp(`^${day}$`) });
  for (let i = 0; i < 8 && !(await dayBtn.count()); i++) await page.getByRole("button", { name: "Bulan berikutnya" }).click();
  await dayBtn.click();
  await page.getByRole("radio", { name: time, exact: true }).click();
  await expect(page.locator('input[name="startsAt"]')).toHaveValue(iso);
}

async function fillGuestForm(page: Page, startsAt: string) {
  await chooseSlot(page, startsAt);
  await page.getByLabel("Nama", { exact: true }).fill("Tamu E2E");
  await page.getByLabel(/^Nomor HP/).fill("0812-5550-9999");
  await page.getByLabel(/^Catatan/).fill("Mohon siapkan ringkasan.");
  await page.getByLabel(/Saya telah membaca/).check();
}

test("tamu (hanya nomor HP, tanpa email) memesan lewat link publik: slot hilang, tiket otomatis, ubah jadwal, batal membebaskan slot", async ({ browser }) => {
  // ===== Pemilik menyiapkan workspace, ketersediaan, dan jenis pertemuan =====
  const owner = await newPage(browser);
  await register(owner, "Pemilik Booking", email("owner"));
  await owner.goto("/dashboard/bisnis-baru");
  await owner.getByText("Mulai dari kosong", { exact: true }).click();
  await owner.locator('input[name="name"]').fill("Praktik Booking E2E");
  await owner.locator('input[name="slug"]').fill(slug);
  await owner.locator('input[name="contactPhone"]').fill("081255500000");
  await owner.getByRole("button", { name: "Buat halaman jadwal saya" }).click();
  await expect(owner.locator(".side-biz").getByText("Praktik Booking E2E")).toBeVisible();

  await owner.goto(`/w/${slug}/jadwal`);
  for (const day of ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"]) await owner.getByLabel(day, { exact: true }).check();
  await clickAndSettle(owner, "Simpan jam kerja");
  await expect(owner.getByText("Pratinjau slot tersedia")).toBeVisible();
  await owner.getByText("+ Tambah layanan baru").click();
  await owner.getByLabel("Nama layanan").last().fill("Konsultasi Publik");
  await owner.getByLabel("Kode untuk link").fill("konsultasi");
  await owner.getByLabel("Link / nomor / alamat").last().fill("https://meet.example.com/e2e-publik");
  await clickAndSettle(owner, "Tambah layanan");
  await expect(owner.getByText(`jadwalin.id/${slug}/konsultasi`)).toBeVisible();
  await expect(owner.getByText("Belum ada yang melayani layanan ini")).toHaveCount(0); // pembuatnya otomatis menjadi host

  // ===== Header keamanan terpasang di halaman publik dan halaman bertoken =====
  const hdr = (await owner.request.get("/masuk")).headers();
  expect(hdr["content-security-policy"]).toMatch(/script-src [^;]*'nonce-[^']+'/);
  expect(hdr["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(hdr["content-security-policy"]).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(hdr["x-content-type-options"]).toBe("nosniff");
  expect(hdr["x-frame-options"]).toBe("DENY");
  expect(hdr["x-powered-by"]).toBeUndefined();
  const tokenHdr = (await owner.request.get("/booking/token-apa-saja")).headers();
  expect(tokenHdr["referrer-policy"]).toBe("no-referrer");
  expect(tokenHdr["cache-control"]).toContain("no-store");

  // ===== Endpoint pemantauan: liveness selalu 200; kesiapan memuat boolean saja dan mendeteksi worker yang tak berjalan =====
  const health = await owner.request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  const ready = await owner.request.get("/api/ready");
  const readyBody = await ready.json();
  expect(readyBody.checks.db).toEqual({ ok: true });
  expect(readyBody.checks.storage).toEqual({ ok: true });
  expect(ready.headers()["cache-control"]).toContain("no-store");
  expect(JSON.stringify(readyBody)).not.toMatch(/postgres|localhost|password|secret/i);
  // Worker tidak berjalan selama E2E: kesiapan harus melaporkannya (bukan pura-pura sehat).
  expect(ready.status()).toBe(readyBody.status === "ok" ? 200 : 503);
  expect(readyBody.checks.worker.ok).toBe(false);

  // ===== Tamu (tanpa login) melihat etalase dan memilih waktu =====
  const guest = await newPage(browser);
  await guest.goto(`/${slug}`);
  await expect(guest.getByRole("heading", { name: "Praktik Booking E2E" })).toBeVisible();
  await guest.getByRole("link", { name: /Konsultasi Publik/ }).click();
  await expect(guest.getByRole("heading", { name: "Konsultasi Publik" })).toBeVisible();
  const slots = await offered(guest);
  expect(slots.length).toBeGreaterThan(10);
  // Slot beberapa hari ke depan (16 slot/hari): pengingat 24 jam dan 1 jam pasti dijadwalkan, tak bergantung jam menjalankan tes.
  const [first, second, third] = [slots[80]!, slots[81]!, slots[82]!];

  // Perlindungan bot: tanpa token Turnstile, pemesanan DITOLAK dan tidak ada booking tercatat.
  await fillGuestForm(guest, first);
  await guest.evaluate(() => document.querySelectorAll('[name="cf-turnstile-response"]').forEach((e) => e.remove()));
  await guest.getByRole("button", { name: "Pesan jadwal" }).click();
  await expect(guest.getByText(/Verifikasi keamanan gagal/)).toBeVisible();
  expect((await pool.query(`SELECT count(*)::int AS n FROM bookings WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = $1)`, [slug])).rows[0].n).toBe(0);

  // Honeypot: bot yang mengisi kolom tersembunyi diarahkan pergi tanpa booking.
  await guest.reload();
  await fillGuestForm(guest, first);
  await guest.evaluate(() => { (document.querySelector('[name="website"]') as HTMLInputElement).value = "http://spam.example"; });
  await expect(guest.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 30_000 });
  await guest.getByRole("button", { name: "Pesan jadwal" }).click();
  await expect(guest).toHaveURL(new RegExp(`/${slug}$`));
  expect((await pool.query(`SELECT count(*)::int AS n FROM bookings WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = $1)`, [slug])).rows[0].n).toBe(0);

  // ===== Pemesanan sungguhan (Turnstile uji Cloudflare lolos) =====
  await guest.goto(`/${slug}/konsultasi`);
  await fillGuestForm(guest, first);
  await expect(guest.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 30_000 });
  await guest.getByRole("button", { name: "Pesan jadwal" }).click();
  await expect(guest.getByRole("heading", { name: "Booking terkonfirmasi" })).toBeVisible();
  const manageUrl = guest.url().split("?")[0]!;
  const token = manageUrl.split("/booking/")[1]!;
  await expect(guest.getByText("Konsultasi Publik")).toBeVisible();
  await expect(guest.getByRole("link", { name: "https://meet.example.com/e2e-publik" })).toBeVisible();

  // ===== Slot yang dipesan langsung hilang untuk pengunjung lain =====
  const other = await newPage(browser);
  await other.goto(`/${slug}/konsultasi`);
  const afterBooking = await offered(other);
  expect(afterBooking).not.toContain(first);
  expect(afterBooking).toContain(second);

  // ===== Tamu hanya memakai nomor HP: tidak ada email ke tamu; pemberitahuan untuk host tetap lewat email =====
  const ws = (await pool.query(`SELECT id FROM workspaces WHERE slug = $1`, [slug])).rows[0].id;
  expect((await pool.query(`SELECT count(*)::int AS n FROM notification_outbox WHERE workspace_id = $1 AND payload->>'subject' LIKE 'Booking terkonfirmasi%'`, [ws])).rows[0].n).toBe(0);
  const hostMails = (await pool.query(`SELECT payload->>'subject' AS subject FROM notification_outbox WHERE recipient = $1`, [email("owner")])).rows;
  expect(hostMails.some((m) => m.subject?.startsWith("Booking baru: Tamu E2E"))).toBe(true);
  // DB hanya menyimpan hash token
  expect((await pool.query(`SELECT count(*)::int AS n FROM bookings WHERE workspace_id = $1 AND cancel_token_hash = encode(sha256(convert_to($2, 'UTF8')), 'hex')`, [ws, token])).rows[0].n).toBe(1);

  // ===== Tiket otomatis untuk host; meeting tertaut =====
  await owner.goto(`/w/${slug}/tiket`);
  await owner.getByRole("link", { name: /Booking: Konsultasi Publik — Konsultasi Publik/ }).click();
  await expect(owner.getByRole("heading", { name: /Booking: Konsultasi Publik/ })).toBeVisible();
  await expect(owner.getByText("ditangani Pemilik Booking")).toBeVisible();
  await expect(owner.getByText(/terjadwal · /)).toBeVisible();
  const ticketUrl = owner.url();

  // ===== Tamu mengubah jadwal =====
  await guest.getByRole("button", { name: "Ubah jadwal" }).click();
  await expect(guest.getByRole("heading", { name: "Ubah jadwal" })).toBeVisible();
  const options = await offered(guest);
  expect(options).toContain(first); // jadwal sendiri tetap bisa dipilih
  expect(options).toContain(third);
  await chooseSlot(guest, third);
  await guest.getByRole("button", { name: "Simpan jadwal baru" }).click();
  await expect(guest.getByText("Jadwal Anda sudah diperbarui.")).toBeVisible();
  await other.reload();
  const afterMove = await offered(other);
  expect(afterMove).toContain(first); // slot lama bebas
  expect(afterMove).not.toContain(third); // slot baru terpakai

  // ===== Tamu membatalkan: slot bebas lagi, pengingat dibatalkan, riwayat tiket mencatatnya =====
  await guest.goto(manageUrl);
  await guest.getByRole("button", { name: "Batalkan booking" }).click();
  await guest.getByRole("button", { name: "Ya, lanjutkan" }).click(); // dialog konfirmasi di dalam halaman
  await expect(guest.getByRole("heading", { name: "Booking dibatalkan" })).toBeVisible();
  await other.reload();
  expect(await offered(other)).toContain(third); // slot yang dibatalkan kembali tersedia

  await owner.goto(ticketUrl);
  await expect(owner.getByText(/membatalkan meeting/)).toBeVisible();
  const events = (await pool.query(`SELECT kind, to_value FROM ticket_events WHERE workspace_id = $1 ORDER BY created_at`, [ws])).rows;
  expect(events.map((e) => e.kind)).toEqual(["created", "assign", "meeting", "meeting", "meeting"]); // dipesan, diubah, dibatalkan
  expect(events.at(-1)).toMatchObject({ kind: "meeting", to_value: "dibatalkan" });

  // Tautan kelola tidak bisa dipakai lagi dan token palsu tidak membuka apa pun.
  await guest.goto(manageUrl);
  await expect(guest.getByText("Booking ini sudah dibatalkan.")).toBeVisible();
  await guest.goto(`/booking/token-palsu-yang-tidak-ada`);
  await expect(guest.getByRole("heading", { name: "Booking tidak ditemukan" })).toBeVisible();

  // CSP tidak boleh memblokir apa pun (hidrasi, Turnstile, formulir) di seluruh alur ini.
  expect(cspViolations, cspViolations.join("\n")).toEqual([]);
});
