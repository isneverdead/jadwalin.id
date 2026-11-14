/**
 * Data contoh untuk PENGEMBANGAN LOKAL (idempoten). Jangan dijalankan di produksi.
 * Akun uji (khusus dev; bukan rahasia sungguhan):
 *   Pemilik workspace : demo@jadwalin.test  / DemoJadwalin-2026!
 *   Klien terdaftar   : klien@jadwalin.test / DemoJadwalin-2026!
 * Jalankan: pnpm --filter @jadwalin/worker seed-dev   (Postgres dev harus hidup dan sudah dimigrasi)
 */
import { createAuth, addClient, createMeetingType, createWorkspace, listPaymentMethods, savePaymentMethod, setWeeklyAvailability } from "@jadwalin/core";
import { createPool } from "@jadwalin/db";
import { createTicket } from "@jadwalin/module-tickets";

if (process.env.NODE_ENV === "production") throw new Error("seed-dev tidak boleh dijalankan di produksi.");
const PASSWORD = "DemoJadwalin-2026!";
const SLUG = "demo-praktik";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL wajib diisi.");
const pool = createPool(url);
const auth = createAuth({ pool, secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-dev-secret-dev-secret-12", baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000" });

async function ensureUser(name: string, email: string): Promise<string> {
  const found = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (found.rowCount) return found.rows[0].id as string;
  await auth.api.signUpEmail({ body: { name, email, password: PASSWORD } });
  await pool.query(`UPDATE users SET email_verified = true, terms_version = 'dev-seed', terms_accepted_at = now() WHERE email = $1`, [email]);
  return (await pool.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0].id as string;
}

const owner = await ensureUser("Dewi Konsultan (Demo)", "demo@jadwalin.test");
const klien = await ensureUser("Budi Klien (Demo)", "klien@jadwalin.test");
const actor = { userId: owner, slug: SLUG };

if ((await pool.query(`SELECT 1 FROM workspaces WHERE slug = $1`, [SLUG])).rowCount) {
  console.log("Data demo sudah ada; tidak ada yang diubah.");
} else {
  const ws = await createWorkspace(pool, owner, { name: "Praktik Demo", slug: SLUG });
  await setWeeklyAvailability(pool, actor, { rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "09:00", end: "16:00" })) });
  const base = { durationMin: 60, slotStepMin: 60, minNoticeMin: 60, maxDaysAhead: 60, locationKind: "link" as const, locationValue: "https://meet.example.com/demo" };
  await createMeetingType(pool, actor, { ...base, slug: "konsultasi-gratis", title: "Konsultasi awal (gratis)" });
  await createMeetingType(pool, actor, { ...base, slug: "sesi-berbayar", title: "Sesi konsultasi berbayar", depositIdr: 150000 });
  const c = await addClient(pool, actor, { name: "Budi Klien (Demo)", email: "klien@jadwalin.test", userId: klien });
  await createTicket(pool, actor, { clientId: c.id, title: "Bantuan pengisian SPT tahunan", description: "Mohon dibantu menyiapkan dokumen SPT 1770.", priority: "high" }, { baseUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3000" });
  await addClient(pool, actor, { name: "Sari Pelanggan", email: "sari@contoh.test", phone: "0812-5550-1234" });
  // Akun pembayaran 'fake' terverifikasi supaya jenis berDP bisa dicoba bila PAYMENT_PROVIDER=fake (dev).
  await pool.query(`INSERT INTO payment_accounts (workspace_id, provider, provider_account_id, kyc_status) VALUES ($1, 'fake', 'M-DEMO', 'verified') ON CONFLICT DO NOTHING`, [ws.id]);
  console.log("Data demo dibuat: workspace /demo-praktik, 2 jenis pertemuan, 2 klien, 1 tiket.");
}
// Metode bayar contoh (ADR 0002) supaya jenis berDP bisa dicoba: nomor rekening FIKTIF khusus dev.
if ((await listPaymentMethods(pool, actor).catch(() => [])).length === 0) {
  await savePaymentMethod(pool, actor, { kind: "bank_transfer", label: "BCA", accountName: "Dewi Konsultan (Demo)", accountNumber: "000 111 2223", instructions: "Cantumkan nama pada berita transfer" });
  await savePaymentMethod(pool, actor, { kind: "ewallet", label: "GoPay", accountName: "Dewi Konsultan (Demo)", accountNumber: "0812-0000-0000" });
  console.log("Metode bayar contoh dibuat (BCA, GoPay).");
}
await pool.end();
