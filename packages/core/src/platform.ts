import { createHash } from "node:crypto";
import { asWorker, schema, withTenant, withWorker, type Db } from "@jadwalin/db";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type pg from "pg";
import { AppError } from "./errors";
import { createPendingFile, finalizeFile, signDownload } from "./files";
import type { StorageAdapter } from "./storage";
import { audit, withWorkspace, type Actor } from "./workspace";

/**
 * Platform jadwalin.id sendiri (ADR 0005): paket langganan, tagihan upgrade lewat TRANSFER MANUAL ke rekening platform
 * (sementara hard-coded), verifikasi oleh superadmin, dan pengelolaan pengguna. jadwalin tetap tidak memproses uang pelanggan;
 * ini murni pembayaran langganan ke pemilik platform.
 */

/** Rekening penerima langganan. Hard-coded sementara; pindah ke konfigurasi bila ada lebih dari satu metode. */
export const PLATFORM_BANK = { bank: "BCA", number: "2490405715", holder: "Fariz Akbar Shalahhuddin" } as const;
/** WhatsApp pemilik platform untuk pintasan "kirim bukti + konteks" (tautan wa.me, bukan API). */
export const PLATFORM_WHATSAPP = "628567500965";

export const PLAN_IDS = ["gratis", "pro", "bisnis"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Harga usulan (docs/pricing.md): tahunan = 10x bulanan. Batas fitur belum ditegakkan di kode (entitlements masih bawaan). */
export const PLANS: Record<PlanId, { label: string; monthlyIdr: number; yearlyIdr: number; highlights: string[] }> = {
  gratis: { label: "Gratis", monthlyIdr: 0, yearlyIdr: 0, highlights: ["3 jenis pertemuan", "2 anggota tim", "Berkas maks. 10 MB", "300 email notifikasi/bulan", "Log audit 100 terakhir"] },
  pro: { label: "Pro", monthlyIdr: 79_000, yearlyIdr: 790_000, highlights: ["15 jenis pertemuan", "5 anggota tim", "Berkas maks. 25 MB", "2.000 email notifikasi/bulan", "Log audit 1.000 terakhir", "Dukungan email"] },
  bisnis: { label: "Bisnis", monthlyIdr: 199_000, yearlyIdr: 1_990_000, highlights: ["50 jenis pertemuan", "20 anggota tim", "Berkas maks. 50 MB", "10.000 email notifikasi/bulan", "Log audit penuh", "Dukungan email prioritas"] },
};

export const PERIODS = { bulanan: { months: 1, label: "Bulanan" }, tahunan: { months: 12, label: "Tahunan (hemat 2 bulan)" } } as const;
export type PeriodId = keyof typeof PERIODS;

export function planPrice(plan: Exclude<PlanId, "gratis">, months: 1 | 12): number {
  return months === 12 ? PLANS[plan].yearlyIdr : PLANS[plan].monthlyIdr;
}

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** Kode tagihan pendek ("INV-7K3M9Q") untuk dibaca manusia, diturunkan dari id; bukan rahasia. */
export function invoiceCode(invoiceId: string): string {
  const h = createHash("sha256").update(`inv:${invoiceId}`).digest();
  let out = "";
  for (let i = 0; i < 6; i++) out += ALPHABET[h[i]! % ALPHABET.length];
  return `INV-${out}`;
}

export function addMonthsUtc(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** Jejak tindakan superadmin: tingkat platform (workspace_id NULL, append-only lewat role worker); usaha sasaran ada di `diff`. */
async function platformAudit(db: Db, e: { actorUserId: string; action: string; entityType: string; entityId: string; workspaceId?: string; diff?: Record<string, unknown> }) {
  await db.insert(schema.auditLog).values({ workspaceId: null, actorUserId: e.actorUserId, action: e.action, entityType: e.entityType, entityId: e.entityId, diff: { ...(e.diff ?? {}), ...(e.workspaceId ? { workspaceId: e.workspaceId } : {}) } });
}

const PROOF_MIMES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const PROOF_MAX_BYTES = 5 * 1024 * 1024;

// --- Sisi pemilik usaha ----------------------------------------------------------------------------------

export interface InvoiceView {
  id: string;
  code: string;
  plan: Exclude<PlanId, "gratis">;
  months: 1 | 12;
  amountIdr: number;
  status: "pending" | "awaiting_verification" | "paid" | "rejected" | "cancelled";
  hasProof: boolean;
  proofNote: string | null;
  submittedAt: Date | null;
  rejectReason: string | null;
  createdAt: Date;
}

export interface SubscriptionView {
  plan: PlanId;
  planUntil: Date | null;
  /** Paket berbayar masih berlaku (belum lewat tanggal berakhir). */
  active: boolean;
  /** Tagihan terbuka (menunggu bukti / verifikasi) bila ada. */
  open: InvoiceView | null;
  history: InvoiceView[];
}

type InvoiceRow = typeof schema.subscriptionInvoices.$inferSelect;
const toInvoiceView = (r: InvoiceRow): InvoiceView => ({
  id: r.id,
  code: invoiceCode(r.id),
  plan: r.plan as InvoiceView["plan"],
  months: r.months as 1 | 12,
  amountIdr: r.amountIdr,
  status: r.status as InvoiceView["status"],
  hasProof: !!r.proofFileId && !!r.submittedAt,
  proofNote: r.proofNote,
  submittedAt: r.submittedAt,
  rejectReason: r.rejectReason,
  createdAt: r.createdAt,
});

export async function getSubscription(pool: pg.Pool, actor: Actor, now = new Date()): Promise<SubscriptionView> {
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    const [ws] = await db.select({ plan: schema.workspaces.plan, planUntil: schema.workspaces.planUntil }).from(schema.workspaces).where(eq(schema.workspaces.id, access.workspaceId)).limit(1);
    const rows = await db.select().from(schema.subscriptionInvoices).orderBy(desc(schema.subscriptionInvoices.createdAt)).limit(20);
    const plan = (PLAN_IDS as readonly string[]).includes(ws?.plan ?? "") ? (ws!.plan as PlanId) : "gratis";
    const active = plan !== "gratis" && !!ws?.planUntil && ws.planUntil.getTime() > now.getTime();
    const open = rows.find((r) => r.status === "pending" || r.status === "awaiting_verification");
    return { plan, planUntil: ws?.planUntil ?? null, active, open: open ? toInvoiceView(open) : null, history: rows.filter((r) => r !== open).map(toInvoiceView) };
  });
}

/** Pemilik membuat tagihan upgrade. Satu tagihan terbuka per usaha. Nominal dari daftar harga, bukan input pengguna. */
export async function createUpgradeInvoice(pool: pg.Pool, actor: Actor, input: { plan: string; period: string }) {
  if (input.plan !== "pro" && input.plan !== "bisnis") throw new AppError("invalid_input", "Pilih paket Pro atau Bisnis.");
  const period = PERIODS[input.period as PeriodId];
  if (!period) throw new AppError("invalid_input", "Pilih periode bulanan atau tahunan.");
  return withWorkspace(pool, actor, "owner", async (db, access) => {
    const amount = planPrice(input.plan as "pro" | "bisnis", period.months);
    try {
      const [row] = await asWorker(db, (w) =>
        w.insert(schema.subscriptionInvoices).values({ workspaceId: access.workspaceId, requestedBy: actor.userId, plan: input.plan, months: period.months, amountIdr: amount }).returning({ id: schema.subscriptionInvoices.id }),
      );
      await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "plan.invoice_created", entityType: "subscription_invoice", entityId: row!.id, diff: { plan: input.plan, months: period.months, amountIdr: amount } });
      return { id: row!.id, code: invoiceCode(row!.id), amountIdr: amount };
    } catch (e) {
      const pg = e as { code?: string; cause?: { code?: string } };
      if (pg.code === "23505" || pg.cause?.code === "23505") throw new AppError("invalid_input", "Masih ada tagihan upgrade yang belum selesai. Selesaikan atau batalkan dulu.");
      throw e;
    }
  });
}

export async function cancelUpgradeInvoice(pool: pg.Pool, actor: Actor, invoiceId: string) {
  return withWorkspace(pool, actor, "owner", async (db, access) => {
    const done = await asWorker(db, (w) =>
      w.update(schema.subscriptionInvoices).set({ status: "cancelled" }).where(and(eq(schema.subscriptionInvoices.id, invoiceId), eq(schema.subscriptionInvoices.workspaceId, access.workspaceId), inArray(schema.subscriptionInvoices.status, ["pending", "awaiting_verification"]))).returning({ id: schema.subscriptionInvoices.id }),
    );
    if (done.length === 0) throw new AppError("invalid_input", "Tagihan ini tidak bisa dibatalkan.");
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "plan.invoice_cancelled", entityType: "subscription_invoice", entityId: invoiceId });
  });
}

/** Minta URL unggah bukti transfer langganan (gambar/PDF ≤ 5 MB). Mengunggah ulang menggantikan bukti sebelumnya. */
export async function requestPlanProofUpload(pool: pg.Pool, actor: Actor, storage: StorageAdapter, invoiceId: string, req: { filename: string; mime: string; sizeBytes: number }) {
  if (!PROOF_MIMES.includes(req.mime.trim().toLowerCase())) throw new AppError("invalid_input", "Bukti harus berupa gambar (PNG/JPG/WebP) atau PDF.");
  if (!Number.isInteger(req.sizeBytes) || req.sizeBytes <= 0 || req.sizeBytes > PROOF_MAX_BYTES) throw new AppError("invalid_input", "Ukuran bukti maksimal 5 MB.");
  return withWorkspace(pool, actor, "owner", async (db, access) => {
    const [inv] = await db.select().from(schema.subscriptionInvoices).where(eq(schema.subscriptionInvoices.id, invoiceId)).limit(1);
    if (!inv) throw new AppError("not_found", "Tagihan tidak ditemukan.");
    if (inv.status !== "pending") throw new AppError("invalid_input", "Tagihan ini tidak menerima bukti lagi.");
    const created = await createPendingFile(db, { workspaceId: access.workspaceId }, storage, actor.userId, req);
    const done = await asWorker(db, (w) => w.update(schema.subscriptionInvoices).set({ proofFileId: created.fileId }).where(and(eq(schema.subscriptionInvoices.id, inv.id), eq(schema.subscriptionInvoices.status, "pending"))).returning({ id: schema.subscriptionInvoices.id }));
    if (done.length === 0) throw new AppError("invalid_input", "Tagihan ini tidak menerima bukti lagi.");
    return created;
  });
}

/** Kirim bukti yang sudah diunggah: berkas diverifikasi, tagihan → menunggu verifikasi superadmin. */
export async function submitPlanProof(pool: pg.Pool, actor: Actor, storage: StorageAdapter, invoiceId: string, note: string | undefined, now = new Date()) {
  const cleanNote = note?.replace(/\s+/g, " ").trim().slice(0, 300) || null;
  return withWorkspace(pool, actor, "owner", async (db, access) => {
    const [inv] = await db.select().from(schema.subscriptionInvoices).where(eq(schema.subscriptionInvoices.id, invoiceId)).limit(1);
    if (!inv) throw new AppError("not_found", "Tagihan ini tidak ditemukan.");
    if (inv.status !== "pending" || !inv.proofFileId) throw new AppError("invalid_input", "Unggah bukti transfer terlebih dulu.");
    const fin = await finalizeFile(db, storage, inv.proofFileId);
    if (!fin.ok) throw new AppError("invalid_input", fin.reason);
    const done = await asWorker(db, (w) => w.update(schema.subscriptionInvoices).set({ status: "awaiting_verification", proofNote: cleanNote, submittedAt: now }).where(and(eq(schema.subscriptionInvoices.id, inv.id), eq(schema.subscriptionInvoices.status, "pending"))).returning({ id: schema.subscriptionInvoices.id }));
    if (done.length === 0) throw new AppError("invalid_input", "Tagihan ini sudah dikirim.");
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "plan.proof_submitted", entityType: "subscription_invoice", entityId: inv.id });
    return { code: invoiceCode(inv.id) };
  });
}

// --- Superadmin platform ---------------------------------------------------------------------------------

export interface AdminIdentity {
  id: string;
  email: string;
  name: string;
}

/**
 * Pagar superadmin: akun HARUS ada, berEmail terverifikasi, tidak ditangguhkan, dan emailnya ada di daftar yang
 * dikonfigurasi (SUPERADMIN_EMAILS). Gagal tertutup dengan "tidak ditemukan" agar keberadaan halaman tidak terbuka.
 */
export async function withSuperadmin<T>(pool: pg.Pool, userId: string, allowed: string[], fn: (db: Db, me: AdminIdentity) => Promise<T>): Promise<T> {
  return withWorker(pool, async (db) => {
    const [u] = await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, verified: schema.users.emailVerified, suspendedAt: schema.users.suspendedAt }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!u || !u.verified || u.suspendedAt || !allowed.map((e) => e.toLowerCase()).includes(u.email.toLowerCase())) throw new AppError("not_found", "Halaman tidak ditemukan.");
    return fn(db, { id: u.id, email: u.email, name: u.name });
  });
}

/** Untuk menampilkan tautan "Admin" saja; otorisasi sesungguhnya selalu lewat withSuperadmin. */
export async function isSuperadmin(pool: pg.Pool, userId: string, allowed: string[]): Promise<boolean> {
  if (allowed.length === 0) return false;
  try {
    return await withSuperadmin(pool, userId, allowed, async () => true);
  } catch (e) {
    if (e instanceof AppError) return false;
    throw e;
  }
}

/** Akun ditangguhkan? (dicek tiap permintaan oleh lapisan web; sesi akun yang ditangguhkan dianggap tidak ada). */
export async function isUserSuspended(pool: pg.Pool, userId: string): Promise<boolean> {
  return withTenant(pool, { userId }, async (db) => {
    const [u] = await db.select({ s: schema.users.suspendedAt }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    return !!u?.s;
  });
}

export interface AdminWorkspaceRef {
  id: string;
  slug: string;
  name: string;
  plan: PlanId;
  planUntil: Date | null;
  role: string;
}
export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  emailVerified: boolean;
  createdAt: Date;
  suspendedAt: Date | null;
  workspaces: AdminWorkspaceRef[];
}

export interface AdminOverview {
  usersTotal: number;
  usersLast7Days: number;
  usersUnverified: number;
  workspacesByPlan: Record<PlanId, number>;
  invoicesAwaiting: number;
  invoicesPending: number;
}

export async function adminOverview(pool: pg.Pool, userId: string, allowed: string[], now = new Date()): Promise<AdminOverview> {
  return withSuperadmin(pool, userId, allowed, async (db) => {
    const since = new Date(now.getTime() - 7 * 86_400_000);
    const [u] = await db.select({ total: sql<number>`count(*)::int`, recent: sql<number>`count(*) FILTER (WHERE ${schema.users.createdAt} >= ${since})::int`, unverified: sql<number>`count(*) FILTER (WHERE NOT ${schema.users.emailVerified})::int` }).from(schema.users);
    const byPlan = await db.select({ plan: schema.workspaces.plan, n: sql<number>`count(*)::int` }).from(schema.workspaces).where(isNull(schema.workspaces.deletedAt)).groupBy(schema.workspaces.plan);
    const inv = await db.select({ status: schema.subscriptionInvoices.status, n: sql<number>`count(*)::int` }).from(schema.subscriptionInvoices).groupBy(schema.subscriptionInvoices.status);
    const wp: Record<PlanId, number> = { gratis: 0, pro: 0, bisnis: 0 };
    for (const r of byPlan) if ((PLAN_IDS as readonly string[]).includes(r.plan)) wp[r.plan as PlanId] = r.n;
    return { usersTotal: u?.total ?? 0, usersLast7Days: u?.recent ?? 0, usersUnverified: u?.unverified ?? 0, workspacesByPlan: wp, invoicesAwaiting: inv.find((x) => x.status === "awaiting_verification")?.n ?? 0, invoicesPending: inv.find((x) => x.status === "pending")?.n ?? 0 };
  });
}

/** Pengguna terbaru (pendaftar baru) atau hasil pencarian nama/email/HP, beserta usaha dan paketnya. */
export async function adminListUsers(pool: pg.Pool, userId: string, allowed: string[], opts: { q?: string; limit?: number } = {}): Promise<AdminUserRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const q = opts.q?.trim().replace(/[%_\\]/g, "") ?? "";
  return withSuperadmin(pool, userId, allowed, async (db) => {
    const users = await db
      .select()
      .from(schema.users)
      .where(q ? or(ilike(schema.users.name, `%${q}%`), ilike(schema.users.email, `%${q}%`), ilike(schema.users.phone, `%${q}%`)) : undefined)
      .orderBy(desc(schema.users.createdAt))
      .limit(limit);
    if (users.length === 0) return [];
    const mem = await db
      .select({ userId: schema.workspaceMembers.userId, role: schema.workspaceMembers.role, id: schema.workspaces.id, slug: schema.workspaces.slug, name: schema.workspaces.name, plan: schema.workspaces.plan, planUntil: schema.workspaces.planUntil })
      .from(schema.workspaceMembers)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
      .where(and(inArray(schema.workspaceMembers.userId, users.map((u) => u.id)), isNull(schema.workspaces.deletedAt)));
    return users.map((u) => ({
      id: u.id, name: u.name, email: u.email, phone: u.phone, emailVerified: u.emailVerified, createdAt: u.createdAt, suspendedAt: u.suspendedAt,
      workspaces: mem.filter((m) => m.userId === u.id).map((m) => ({ id: m.id, slug: m.slug, name: m.name, plan: (PLAN_IDS as readonly string[]).includes(m.plan) ? (m.plan as PlanId) : "gratis", planUntil: m.planUntil, role: m.role })),
    }));
  });
}

export interface AdminInvoiceRow extends InvoiceView {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  currentPlan: PlanId;
  currentUntil: Date | null;
  requesterName: string;
  requesterEmail: string;
  requesterPhone: string | null;
  contactPhone: string | null;
  proofMime: string | null;
}

export async function adminListInvoices(pool: pg.Pool, userId: string, allowed: string[], filter: "open" | "all" = "open"): Promise<AdminInvoiceRow[]> {
  return withSuperadmin(pool, userId, allowed, async (db) => {
    const rows = await db
      .select({ i: schema.subscriptionInvoices, wsName: schema.workspaces.name, wsSlug: schema.workspaces.slug, wsPlan: schema.workspaces.plan, wsUntil: schema.workspaces.planUntil, wsPhone: schema.workspaces.contactPhone, uName: schema.users.name, uEmail: schema.users.email, uPhone: schema.users.phone, mime: schema.files.mime })
      .from(schema.subscriptionInvoices)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.subscriptionInvoices.workspaceId))
      .innerJoin(schema.users, eq(schema.users.id, schema.subscriptionInvoices.requestedBy))
      .leftJoin(schema.files, eq(schema.files.id, schema.subscriptionInvoices.proofFileId))
      .where(filter === "open" ? inArray(schema.subscriptionInvoices.status, ["pending", "awaiting_verification"]) : undefined)
      .orderBy(sql`(${schema.subscriptionInvoices.status} = 'awaiting_verification') DESC`, desc(schema.subscriptionInvoices.createdAt))
      .limit(100);
    return rows.map((r) => ({
      ...toInvoiceView(r.i), workspaceId: r.i.workspaceId, workspaceName: r.wsName, workspaceSlug: r.wsSlug,
      currentPlan: (PLAN_IDS as readonly string[]).includes(r.wsPlan) ? (r.wsPlan as PlanId) : "gratis", currentUntil: r.wsUntil,
      requesterName: r.uName, requesterEmail: r.uEmail, requesterPhone: r.uPhone, contactPhone: r.wsPhone, proofMime: r.mime ?? null,
    }));
  });
}

/** URL unduh bukti transfer langganan (berumur pendek). */
export async function adminInvoiceProofUrl(pool: pg.Pool, userId: string, allowed: string[], storage: StorageAdapter, invoiceId: string) {
  return withSuperadmin(pool, userId, allowed, async (db, me) => {
    const [inv] = await db.select({ fileId: schema.subscriptionInvoices.proofFileId, workspaceId: schema.subscriptionInvoices.workspaceId }).from(schema.subscriptionInvoices).where(eq(schema.subscriptionInvoices.id, invoiceId)).limit(1);
    if (!inv?.fileId) throw new AppError("not_found", "Bukti tidak ditemukan.");
    const [f] = await db.select({ key: schema.files.storageKey, filename: schema.files.filename, status: schema.files.status, mime: schema.files.mime }).from(schema.files).where(eq(schema.files.id, inv.fileId)).limit(1);
    if (!f || f.status !== "ready") throw new AppError("not_found", "Bukti tidak ditemukan.");
    await platformAudit(db, { actorUserId: me.id, action: "plan.proof_viewed", entityType: "subscription_invoice", entityId: invoiceId, workspaceId: inv.workspaceId });
    return { url: await storage.presignDownload({ key: f.key, filename: f.filename }), mime: f.mime };
  });
}

export type InvoiceDecision = { approve: true } | { approve: false; reason: string };

/** Superadmin memverifikasi pembayaran langganan: setuju → paket aktif (diperpanjang bila paket sama masih berlaku); tolak → alasan. */
export async function adminReviewInvoice(pool: pg.Pool, userId: string, allowed: string[], invoiceId: string, decision: InvoiceDecision, now = new Date()) {
  if (!decision.approve) {
    const reason = decision.reason.replace(/\s+/g, " ").trim();
    if (reason.length < 3 || reason.length > 200) throw new AppError("invalid_input", "Alasan penolakan 3–200 karakter.");
    decision = { approve: false, reason };
  }
  return withSuperadmin(pool, userId, allowed, async (db, me) => {
    const [inv] = await db.select().from(schema.subscriptionInvoices).where(eq(schema.subscriptionInvoices.id, invoiceId)).for("update").limit(1);
    if (!inv) throw new AppError("not_found", "Tagihan tidak ditemukan.");
    if (inv.status !== "awaiting_verification" && inv.status !== "pending") throw new AppError("invalid_input", "Tagihan ini sudah diputuskan.");
    if (!decision.approve) {
      await db.update(schema.subscriptionInvoices).set({ status: "rejected", rejectReason: decision.reason, reviewedBy: me.id, reviewedAt: now }).where(eq(schema.subscriptionInvoices.id, inv.id));
      await platformAudit(db, { actorUserId: me.id, action: "plan.invoice_rejected", entityType: "subscription_invoice", entityId: inv.id, workspaceId: inv.workspaceId, diff: { reason: decision.reason } });
      return { status: "rejected" as const };
    }
    const [ws] = await db.select({ plan: schema.workspaces.plan, until: schema.workspaces.planUntil }).from(schema.workspaces).where(eq(schema.workspaces.id, inv.workspaceId)).for("update").limit(1);
    if (!ws) throw new AppError("not_found", "Usaha tidak ditemukan.");
    const base = ws.plan === inv.plan && ws.until && ws.until.getTime() > now.getTime() ? ws.until : now;
    const until = addMonthsUtc(base, inv.months);
    await db.update(schema.workspaces).set({ plan: inv.plan, planUntil: until }).where(eq(schema.workspaces.id, inv.workspaceId));
    await db.update(schema.subscriptionInvoices).set({ status: "paid", reviewedBy: me.id, reviewedAt: now }).where(eq(schema.subscriptionInvoices.id, inv.id));
    await platformAudit(db, { actorUserId: me.id, action: "plan.activated", entityType: "workspace", entityId: inv.workspaceId, workspaceId: inv.workspaceId, diff: { plan: inv.plan, until: until.toISOString(), invoice: inv.id } });
    return { status: "paid" as const, plan: inv.plan as PlanId, until };
  });
}

/** Atur paket usaha langsung (mis. gratis-kan, perpanjang manual, atau turunkan). `until` kosong = tanpa batas untuk paket berbayar. */
export async function adminSetPlan(pool: pg.Pool, userId: string, allowed: string[], workspaceId: string, plan: string, until: Date | null) {
  if (!(PLAN_IDS as readonly string[]).includes(plan)) throw new AppError("invalid_input", "Paket tidak dikenal.");
  if (until && Number.isNaN(until.getTime())) throw new AppError("invalid_input", "Tanggal berakhir tidak valid.");
  return withSuperadmin(pool, userId, allowed, async (db, me) => {
    const done = await db.update(schema.workspaces).set({ plan, planUntil: plan === "gratis" ? null : until }).where(eq(schema.workspaces.id, workspaceId)).returning({ id: schema.workspaces.id });
    if (done.length === 0) throw new AppError("not_found", "Usaha tidak ditemukan.");
    await platformAudit(db, { actorUserId: me.id, action: "plan.set_by_admin", entityType: "workspace", entityId: workspaceId, workspaceId, diff: { plan, until: until?.toISOString() ?? null } });
  });
}

/** Tangguhkan/aktifkan akun. Superadmin tidak bisa menangguhkan dirinya atau superadmin lain. */
export async function adminSetSuspended(pool: pg.Pool, userId: string, allowed: string[], targetUserId: string, suspended: boolean, now = new Date()) {
  return withSuperadmin(pool, userId, allowed, async (db, me) => {
    if (targetUserId === me.id) throw new AppError("invalid_input", "Anda tidak bisa menangguhkan akun sendiri.");
    const [t] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, targetUserId)).limit(1);
    if (!t) throw new AppError("not_found", "Pengguna tidak ditemukan.");
    if (allowed.map((e) => e.toLowerCase()).includes(t.email.toLowerCase())) throw new AppError("invalid_input", "Akun superadmin tidak bisa ditangguhkan.");
    await db.update(schema.users).set({ suspendedAt: suspended ? now : null }).where(eq(schema.users.id, targetUserId));
    // Usaha yang dimiliki akun ini ikut disembunyikan dari halaman publik (dipulihkan saat akun diaktifkan lagi).
    const owned = await db.select({ id: schema.workspaceMembers.workspaceId }).from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.userId, targetUserId), eq(schema.workspaceMembers.role, "owner")));
    for (const w of owned) await db.update(schema.workspaces).set({ blockedAt: suspended ? now : null }).where(eq(schema.workspaces.id, w.id));
    await platformAudit(db, { actorUserId: me.id, action: suspended ? "user.suspended" : "user.reinstated", entityType: "user", entityId: targetUserId });
  });
}
