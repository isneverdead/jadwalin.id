import { randomUUID } from "node:crypto";
import { createPool, schema, withTenant } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppError, PLANS, S3Storage, addMonthsUtc, adminInvoiceProofUrl, adminListInvoices, adminListUsers, adminOverview, adminReviewInvoice, adminSetPlan, adminSetSuspended, cancelUpgradeInvoice,
  createUpgradeInvoice, createWorkspace, getSubscription, invoiceCode, isSuperadmin, isUserSuspended, planPrice, requestPlanProofUpload, submitPlanProof,
} from "../src";
import { inviteAndAccept } from "./helpers";

const url = process.env.DATABASE_URL;
const s3 = { endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET, accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY };
const haveS3 = Boolean(s3.endpoint && s3.bucket && s3.accessKeyId && s3.secretAccessKey);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe.skipIf(!url || !haveS3)("platform: paket, upgrade (transfer manual), superadmin (ADR 0005)", () => {
  let pool: pg.Pool;
  let storage: S3Storage;
  const sfx = randomUUID().slice(0, 8);
  const u = {} as Record<"owner" | "staff" | "outsider" | "admin" | "unverified" | "victim", string>;
  let slug: string;
  let wsId: string;
  let allowed: string[];
  const owner = () => ({ userId: u.owner, slug });
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${(e as Error).message}`));
  const NOW = new Date("2037-05-10T00:00:00Z");

  async function pay(plan: string, period: string) {
    const inv = await createUpgradeInvoice(pool, owner(), { plan, period });
    const { upload } = await requestPlanProofUpload(pool, owner(), storage, inv.id, { filename: "bukti.png", mime: "image/png", sizeBytes: PNG.byteLength });
    expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body: PNG as unknown as BodyInit })).ok).toBe(true);
    await submitPlanProof(pool, owner(), storage, inv.id, "Transfer dari BCA a.n. Pemilik", NOW);
    return inv;
  }

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    storage = new S3Storage({ endpoint: s3.endpoint!, region: "auto", bucket: s3.bucket!, accessKeyId: s3.accessKeyId!, secretAccessKey: s3.secretAccessKey!, forcePathStyle: true });
    await storage.ensureBucket();
    const mk = async (k: keyof typeof u, verified = true, email = `${k}-${sfx}@plat.local`) => { u[k] = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, $2, $3) RETURNING id`, [email, k, verified])).rows[0].id; };
    for (const k of ["owner", "staff", "outsider", "victim"] as const) await mk(k);
    await mk("admin", true, `admin-${sfx}@plat.local`);
    await mk("unverified", false, `unv-${sfx}@plat.local`);
    allowed = [`ADMIN-${sfx}@Plat.Local`, `unv-${sfx}@plat.local`]; // huruf besar sengaja: pencocokan tak peka kapital
    slug = `plat-${sfx}`;
    wsId = (await createWorkspace(pool, u.owner, { name: "Usaha Platform", slug })).id;
    await createWorkspace(pool, u.outsider, { name: "Lain", slug: `plat-lain-${sfx}` });
    await createWorkspace(pool, u.victim, { name: "Korban Tangguh", slug: `plat-korban-${sfx}` });
    await inviteAndAccept(pool, owner(), { userId: u.staff, email: `staff-${sfx}@plat.local`, role: "staff" });
  });
  afterAll(async () => pool?.end());

  it("harga: tahunan = 10x bulanan; kode tagihan stabil; tambah bulan aman di akhir bulan", () => {
    expect(planPrice("pro", 1)).toBe(79000);
    expect(planPrice("pro", 12)).toBe(790000);
    expect(planPrice("bisnis", 12)).toBe(PLANS.bisnis.monthlyIdr * 10);
    expect(invoiceCode("abc")).toMatch(/^INV-[A-Z0-9]{6}$/);
    expect(invoiceCode("abc")).toBe(invoiceCode("abc"));
    expect(addMonthsUtc(new Date("2037-01-31T00:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2037-02-28");
    expect(addMonthsUtc(new Date("2037-05-10T00:00:00Z"), 12).toISOString().slice(0, 10)).toBe("2038-05-10");
  });

  it("tagihan upgrade: hanya pemilik; paket/periode divalidasi; satu tagihan terbuka; nominal dari daftar harga", async () => {
    expect(await code(createUpgradeInvoice(pool, owner(), { plan: "gratis", period: "bulanan" }))).toBe("invalid_input");
    expect(await code(createUpgradeInvoice(pool, owner(), { plan: "pro", period: "mingguan" }))).toBe("invalid_input");
    expect(await code(createUpgradeInvoice(pool, { userId: u.staff, slug }, { plan: "pro", period: "bulanan" }))).toBe("forbidden");
    expect(await code(createUpgradeInvoice(pool, { userId: u.outsider, slug }, { plan: "pro", period: "bulanan" }))).toBe("not_found");
    const inv = await createUpgradeInvoice(pool, owner(), { plan: "pro", period: "tahunan" });
    expect(inv.amountIdr).toBe(790000);
    expect(inv.code).toMatch(/^INV-/);
    expect(await code(createUpgradeInvoice(pool, owner(), { plan: "bisnis", period: "bulanan" }))).toBe("invalid_input"); // satu tagihan terbuka
    const sub = await getSubscription(pool, owner(), NOW);
    expect(sub).toMatchObject({ plan: "gratis", active: false, open: { id: inv.id, status: "pending", amountIdr: 790000, hasProof: false } });
    expect(await code(submitPlanProof(pool, owner(), storage, inv.id, undefined, NOW))).toBe("invalid_input"); // belum ada bukti
    await cancelUpgradeInvoice(pool, owner(), inv.id);
    expect(await code(cancelUpgradeInvoice(pool, owner(), inv.id))).toBe("invalid_input");
    expect((await getSubscription(pool, owner(), NOW)).open).toBeNull();
  });

  it("ALUR UPGRADE: bayar → bukti → superadmin melihat bukti → setuju → paket aktif; perpanjang dari tanggal berakhir; ganti paket mulai dari sekarang", async () => {
    const inv = await pay("pro", "bulanan");
    expect((await getSubscription(pool, owner(), NOW)).open).toMatchObject({ status: "awaiting_verification", hasProof: true, proofNote: "Transfer dari BCA a.n. Pemilik" });
    expect(await code(requestPlanProofUpload(pool, owner(), storage, inv.id, { filename: "x.png", mime: "image/png", sizeBytes: 5 }))).toBe("invalid_input"); // sudah dikirim

    const queue = await adminListInvoices(pool, u.admin, allowed);
    const row = queue.find((r) => r.id === inv.id)!;
    expect(row).toMatchObject({ status: "awaiting_verification", workspaceSlug: slug, requesterName: "owner", plan: "pro", amountIdr: 79000, currentPlan: "gratis", proofMime: "image/png" });
    const dl = await adminInvoiceProofUrl(pool, u.admin, allowed, storage, inv.id);
    expect((await fetch(dl.url)).ok).toBe(true);

    expect(await adminReviewInvoice(pool, u.admin, allowed, inv.id, { approve: true }, NOW)).toMatchObject({ status: "paid", plan: "pro" });
    let sub = await getSubscription(pool, owner(), NOW);
    expect(sub.plan).toBe("pro");
    expect(sub.active).toBe(true);
    expect(sub.planUntil!.toISOString().slice(0, 10)).toBe("2037-06-10");
    expect(sub.history[0]).toMatchObject({ status: "paid" });
    expect(await code(adminReviewInvoice(pool, u.admin, allowed, inv.id, { approve: true }, NOW))).toBe("invalid_input"); // sudah diputuskan
    expect((await pool.query(`SELECT 1 FROM audit_log WHERE workspace_id IS NULL AND action = 'plan.activated' AND diff->>'workspaceId' = $1`, [wsId])).rowCount).toBe(1);

    // Perpanjang paket yang sama: dihitung dari tanggal berakhir, bukan dari sekarang.
    const inv2 = await pay("pro", "tahunan");
    await adminReviewInvoice(pool, u.admin, allowed, inv2.id, { approve: true }, NOW);
    sub = await getSubscription(pool, owner(), NOW);
    expect(sub.planUntil!.toISOString().slice(0, 10)).toBe("2038-06-10");

    // Ganti ke paket lain: mulai dari sekarang.
    const inv3 = await pay("bisnis", "bulanan");
    await adminReviewInvoice(pool, u.admin, allowed, inv3.id, { approve: true }, NOW);
    sub = await getSubscription(pool, owner(), NOW);
    expect(sub.plan).toBe("bisnis");
    expect(sub.planUntil!.toISOString().slice(0, 10)).toBe("2037-06-10");
  });

  it("tolak: alasan wajib, paket tidak berubah, pemilik boleh membuat tagihan baru", async () => {
    const before = await getSubscription(pool, owner(), NOW);
    const inv = await pay("pro", "bulanan");
    expect(await code(adminReviewInvoice(pool, u.admin, allowed, inv.id, { approve: false, reason: "" }, NOW))).toBe("invalid_input");
    expect(await adminReviewInvoice(pool, u.admin, allowed, inv.id, { approve: false, reason: "Nominal tidak sesuai" }, NOW)).toEqual({ status: "rejected" });
    const after = await getSubscription(pool, owner(), NOW);
    expect(after.plan).toBe(before.plan);
    expect(after.planUntil?.getTime()).toBe(before.planUntil?.getTime());
    expect(after.history[0]).toMatchObject({ status: "rejected", rejectReason: "Nominal tidak sesuai" });
    await createUpgradeInvoice(pool, owner(), { plan: "pro", period: "bulanan" });
    await cancelUpgradeInvoice(pool, owner(), (await getSubscription(pool, owner(), NOW)).open!.id);
  });

  it("PAGAR SUPERADMIN: bukan di daftar, email belum terverifikasi, atau pemilik biasa = 'tidak ditemukan'", async () => {
    expect(await code(adminOverview(pool, u.owner, allowed))).toBe("not_found"); // di daftar? tidak (hanya admin)
    expect(await code(adminOverview(pool, u.outsider, allowed))).toBe("not_found");
    expect(await code(adminOverview(pool, u.unverified, allowed))).toBe("not_found"); // ada di daftar tapi belum terverifikasi
    expect(await code(adminOverview(pool, u.admin, []))).toBe("not_found"); // daftar kosong = tak ada superadmin
    expect(await code(adminListUsers(pool, u.staff, allowed))).toBe("not_found");
    expect(await code(adminReviewInvoice(pool, u.outsider, allowed, randomUUID(), { approve: true }))).toBe("not_found");
    expect(await isSuperadmin(pool, u.admin, allowed)).toBe(true);
    expect(await isSuperadmin(pool, u.owner, allowed)).toBe(false);
    expect(await isSuperadmin(pool, u.unverified, allowed)).toBe(false);
    const ov = await adminOverview(pool, u.admin, allowed, NOW);
    expect(ov.usersTotal).toBeGreaterThanOrEqual(6);
    expect(ov.workspacesByPlan.bisnis).toBeGreaterThanOrEqual(1);
  });

  it("pemilik TIDAK bisa mengubah paketnya sendiri (hak kolom di DB), walau lewat SQL role aplikasi", async () => {
    const attempt = await withTenant(pool, { userId: u.owner, workspaceId: wsId }, (db) => db.update(schema.workspaces).set({ plan: "bisnis", planUntil: new Date("2099-01-01") }).where(eq(schema.workspaces.id, wsId))).then(() => "ok", () => "ditolak");
    expect(attempt).toBe("ditolak");
    // Kolom lain tetap bisa diubah role aplikasi (mis. nama).
    const fine = await withTenant(pool, { userId: u.owner, workspaceId: wsId }, (db) => db.update(schema.workspaces).set({ name: "Usaha Platform" })).then(() => "ok", (e) => `x:${(e as Error).message}`);
    expect(fine).toBe("ok");
    // Tagihan tidak bisa dibaca usaha lain.
    const other = (await pool.query(`SELECT id FROM workspaces WHERE slug = $1`, [`plat-lain-${sfx}`])).rows[0].id as string;
    expect(await withTenant(pool, { userId: u.outsider, workspaceId: other }, (db) => db.select().from(schema.subscriptionInvoices))).toHaveLength(0);
    const NIL = "00000000-0000-0000-0000-000000000000";
    const asPublic = await withTenant(pool, { userId: NIL, workspaceId: wsId, actor: "public" }, (db) => db.select().from(schema.subscriptionInvoices)).catch(() => "ditolak");
    expect(asPublic === "ditolak" || (Array.isArray(asPublic) && asPublic.length === 0)).toBe(true);
  });

  it("kelola pengguna: cari, atur paket manual, tangguhkan/aktifkan (tidak bisa diri sendiri atau superadmin lain)", async () => {
    const found = await adminListUsers(pool, u.admin, allowed, { q: `owner-${sfx}` });
    expect(found).toHaveLength(1);
    expect(found[0]!.workspaces.map((w) => w.slug)).toContain(slug);
    expect(found[0]).toMatchObject({ emailVerified: true, suspendedAt: null });
    const recent = await adminListUsers(pool, u.admin, allowed, { limit: 3 });
    expect(recent.length).toBeLessThanOrEqual(3);

    await adminSetPlan(pool, u.admin, allowed, wsId, "gratis", null);
    expect((await getSubscription(pool, owner(), NOW)).plan).toBe("gratis");
    expect(await code(adminSetPlan(pool, u.admin, allowed, wsId, "platinum", null))).toBe("invalid_input");
    expect(await code(adminSetPlan(pool, u.admin, allowed, randomUUID(), "pro", NOW))).toBe("not_found");

    expect(await isUserSuspended(pool, u.victim)).toBe(false);
    await adminSetSuspended(pool, u.admin, allowed, u.victim, true);
    expect(await isUserSuspended(pool, u.victim)).toBe(true);
    expect((await adminListUsers(pool, u.admin, allowed, { q: `victim-${sfx}` }))[0]!.suspendedAt).not.toBeNull();
    await adminSetSuspended(pool, u.admin, allowed, u.victim, false);
    expect(await isUserSuspended(pool, u.victim)).toBe(false);
    expect(await code(adminSetSuspended(pool, u.admin, allowed, u.admin, true))).toBe("invalid_input");
    expect(await code(adminSetSuspended(pool, u.admin, allowed, u.unverified, true))).toBe("invalid_input"); // superadmin lain
    expect(await code(adminSetSuspended(pool, u.owner, allowed, u.victim, true))).toBe("not_found"); // bukan superadmin
    // Superadmin yang ditangguhkan kehilangan aksesnya.
    await pool.query(`UPDATE users SET suspended_at = now() WHERE id = $1`, [u.admin]);
    expect(await code(adminOverview(pool, u.admin, allowed))).toBe("not_found");
    await pool.query(`UPDATE users SET suspended_at = NULL WHERE id = $1`, [u.admin]);
  });
});
