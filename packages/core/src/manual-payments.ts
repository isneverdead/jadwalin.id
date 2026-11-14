import { asWorker, schema, withTenant, type Db } from "@jadwalin/db";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type pg from "pg";
import { AppError } from "./errors";
import { createPendingFile, finalizeFile, signDownload } from "./files";
import { notifyEmails, notifyStaff } from "./notify";
import { confirmSubject, lockPayment, transition, type PaymentDeps } from "./payments";
import { getBookingByToken } from "./public-booking";
import { consumeRateLimit, rateKey } from "./rate-limit";
import type { StorageAdapter } from "./storage";
import { hashToken } from "./tokens";
import { audit, withWorkspace, type Actor } from "./workspace";

/**
 * Pembayaran MANUAL (ADR 0002): penyedia jasa mengatur metode bayarnya sendiri, pelanggan membayar di luar sistem lalu
 * mengunggah bukti, staf memverifikasi. jadwalin tidak memproses atau menampung dana.
 */
export const MANUAL_HOLD_MIN = 180;
export const REJECT_EXTENSION_MIN = 60;
export const MAX_PAYMENT_METHODS = 8;
const MAX_PROOFS_PER_PAYMENT = 5;
const PROOF_MAX_BYTES = 5 * 1024 * 1024;
const PROOF_MIMES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const KINDS = ["bank_transfer", "qris", "ewallet", "other"] as const;
export type PaymentMethodKind = (typeof KINDS)[number];

// --- Metode bayar (staf) ---------------------------------------------------------------------------

export interface PaymentMethodInput {
  kind: PaymentMethodKind;
  label: string;
  accountName?: string;
  accountNumber?: string;
  instructions?: string;
  /** Wajib untuk kind 'qris': berkas gambar yang sudah diunggah lewat modul berkas (status ready). */
  qrisFileId?: string | null;
}

async function cleanMethod(db: Db, input: PaymentMethodInput) {
  if (!KINDS.includes(input.kind)) throw new AppError("invalid_input", "Jenis metode bayar tidak valid.");
  const label = input.label.replace(/\s+/g, " ").trim();
  if (label.length < 2 || label.length > 40) throw new AppError("invalid_input", "Nama metode 2–40 karakter (mis. BCA, QRIS Toko, GoPay).");
  const accountName = input.accountName?.replace(/\s+/g, " ").trim().slice(0, 80) || null;
  const accountNumber = input.accountNumber?.trim() || null;
  const instructions = input.instructions?.trim() || null;
  if (instructions && instructions.length > 500) throw new AppError("invalid_input", "Petunjuk maksimal 500 karakter.");
  if (accountNumber && !/^[0-9A-Za-z .\-/]{3,40}$/.test(accountNumber)) throw new AppError("invalid_input", "Nomor rekening/akun tidak valid (3–40 karakter angka/huruf).");
  if ((input.kind === "bank_transfer" || input.kind === "ewallet") && (!accountNumber || !accountName)) throw new AppError("invalid_input", "Nama pemilik dan nomor rekening/akun wajib diisi.");
  if (input.kind === "other" && !instructions) throw new AppError("invalid_input", "Isi petunjuk pembayaran untuk metode lainnya.");
  let qrisFileId: string | null = null;
  if (input.kind === "qris") {
    if (!input.qrisFileId) throw new AppError("invalid_input", "Unggah gambar QRIS terlebih dulu.");
    const [f] = await db.select({ id: schema.files.id, mime: schema.files.mime, status: schema.files.status }).from(schema.files).where(eq(schema.files.id, input.qrisFileId)).limit(1);
    if (!f || f.status !== "ready" || !f.mime.startsWith("image/")) throw new AppError("invalid_input", "Berkas QRIS harus berupa gambar yang sudah selesai diunggah.");
    qrisFileId = f.id;
  }
  return { kind: input.kind, label, accountName, accountNumber, instructions, qrisFileId };
}

export async function listPaymentMethods(pool: pg.Pool, actor: Actor) {
  return withWorkspace(pool, actor, "staff", (db) => db.select().from(schema.paymentMethods).orderBy(asc(schema.paymentMethods.sortOrder), asc(schema.paymentMethods.createdAt)));
}

export async function savePaymentMethod(pool: pg.Pool, actor: Actor, input: PaymentMethodInput, methodId?: string) {
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    const values = await cleanMethod(db, input);
    if (methodId) {
      const done = await db.update(schema.paymentMethods).set(values).where(eq(schema.paymentMethods.id, methodId)).returning({ id: schema.paymentMethods.id });
      if (done.length === 0) throw new AppError("not_found", "Metode bayar tidak ditemukan.");
      await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "payment_method.updated", entityType: "payment_method", entityId: methodId, diff: { kind: values.kind, label: values.label } });
      return { id: methodId };
    }
    const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.paymentMethods);
    if (n >= MAX_PAYMENT_METHODS) throw new AppError("invalid_input", `Maksimal ${MAX_PAYMENT_METHODS} metode bayar.`);
    const [row] = await db.insert(schema.paymentMethods).values({ workspaceId: access.workspaceId, ...values, sortOrder: n }).returning({ id: schema.paymentMethods.id });
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "payment_method.created", entityType: "payment_method", entityId: row!.id, diff: { kind: values.kind, label: values.label } });
    return row!;
  });
}

export async function setPaymentMethodActive(pool: pg.Pool, actor: Actor, methodId: string, active: boolean) {
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    const done = await db.update(schema.paymentMethods).set({ active }).where(eq(schema.paymentMethods.id, methodId)).returning({ id: schema.paymentMethods.id });
    if (done.length === 0) throw new AppError("not_found", "Metode bayar tidak ditemukan.");
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: active ? "payment_method.enabled" : "payment_method.disabled", entityType: "payment_method", entityId: methodId });
  });
}

export async function deletePaymentMethod(pool: pg.Pool, actor: Actor, methodId: string) {
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    const done = await db.delete(schema.paymentMethods).where(eq(schema.paymentMethods.id, methodId)).returning({ id: schema.paymentMethods.id });
    if (done.length === 0) throw new AppError("not_found", "Metode bayar tidak ditemukan.");
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "payment_method.deleted", entityType: "payment_method", entityId: methodId });
  });
}

// --- Membuat pembayaran manual saat booking (di transaksi booking) --------------------------------------

/** Dipanggil di dalam transaksi pemesanan: baris `payments` 'pending' + event, atomik dengan booking. Penulisan lewat role worker. */
export async function createManualPaymentInTx(db: Db, p: { workspaceId: string; bookingId: string; amountIdr: number; now: Date; subjectType?: "booking" | "reservation" }): Promise<{ paymentId: string; expiresAt: Date }> {
  if (!Number.isSafeInteger(p.amountIdr) || p.amountIdr < 1000) throw new AppError("invalid_input", "Nominal DP minimal Rp1.000.");
  const id = crypto.randomUUID();
  const expiresAt = new Date(p.now.getTime() + MANUAL_HOLD_MIN * 60_000);
  await asWorker(db, async (w) => {
    await w.insert(schema.payments).values({ id, workspaceId: p.workspaceId, provider: "manual", providerRef: id, amountIdr: p.amountIdr, platformFeeIdr: 0, status: "pending", subjectType: p.subjectType ?? "booking", subjectId: p.bookingId, idempotencyKey: `${p.subjectType ?? "booking"}:${p.bookingId}`, expiresAt });
    await w.insert(schema.paymentEvents).values({ workspaceId: p.workspaceId, paymentId: id, fromStatus: null, toStatus: "pending", source: "api", raw: null });
  });
  return { paymentId: id, expiresAt };
}

/** Pra-periksa saat memesan jenis berDP: penyedia jasa harus sudah punya minimal satu metode bayar aktif. */
export async function hasActivePaymentMethod(db: Db, workspaceId: string): Promise<boolean> {
  const rows = await asWorker(db, (w) => w.select({ id: schema.paymentMethods.id }).from(schema.paymentMethods).where(and(eq(schema.paymentMethods.workspaceId, workspaceId), eq(schema.paymentMethods.active, true))).limit(1));
  return rows.length > 0;
}

// --- Sisi pelanggan (lewat token booking) -----------------------------------------------------------

export interface ManualPaymentView {
  payment: { id: string; status: string; amountIdr: number; expiresAt: Date };
  methods: { id: string; kind: string; label: string; accountName: string | null; accountNumber: string | null; instructions: string | null; qrisUrl: string | null }[];
  proof: { status: string; rejectReason: string | null; submittedAt: Date } | null;
  /** Pelanggan boleh mengunggah bukti (status 'pending' dan booking masih ditahan). */
  canUpload: boolean;
}

/** Subjek yang dibayar lewat tautan rahasia: booking (jasa) atau reservasi (sewa). Token hanya disimpan sebagai hash. */
export interface PayableSubject {
  type: "booking" | "reservation";
  id: string;
  /** 'pending' = masih menunggu pembayaran (slot/unit ditahan). */
  status: string;
  workspaceId: string;
  memberId: string | null;
  title: string;
  wsSlug: string;
}

async function resolveSubject(pool: pg.Pool, token: string): Promise<(PayableSubject & { resourceId?: string }) | null> {
  const b = await getBookingByToken(pool, token);
  if (b) return { type: "booking", id: b.id, status: b.status, workspaceId: b.workspaceId, memberId: b.memberId, title: b.type.title, wsSlug: b.workspace.slug };
  return withTenant(pool, { userId: NIL_UUID, actor: "public", bookingTokenHash: hashToken(token) }, async (db) => {
    const [r] = await db
      .select({ id: schema.reservations.id, status: schema.reservations.status, workspaceId: schema.reservations.workspaceId, resourceId: schema.reservations.resourceId, wsSlug: schema.workspaces.slug })
      .from(schema.reservations)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.reservations.workspaceId))
      .where(eq(schema.reservations.tokenHash, hashToken(token)))
      .limit(1);
    // Nama produk dibaca nanti di konteks workspace (tabel resources hanya terbaca dengan konteks itu).
    return r ? ({ type: "reservation", id: r.id, status: r.status, workspaceId: r.workspaceId, memberId: null, title: "", wsSlug: r.wsSlug, resourceId: r.resourceId } satisfies PayableSubject & { resourceId: string }) : null;
  });
}

async function publicCtx<T>(pool: pg.Pool, token: string, fn: (db: Db, b: PayableSubject) => Promise<T>): Promise<T | null> {
  if (!token || token.length > 200) return null;
  const b = await resolveSubject(pool, token);
  if (!b) return null;
  return withTenant(pool, { userId: NIL_UUID, workspaceId: b.workspaceId, actor: "public", bookingTokenHash: hashToken(token) }, async (db) => {
    let title = b.title;
    if (b.type === "reservation" && b.resourceId) {
      const [r] = await db.select({ name: schema.resources.name }).from(schema.resources).where(eq(schema.resources.id, b.resourceId)).limit(1);
      title = r?.name ?? "Sewa";
    }
    return fn(db, { ...b, title });
  });
}

export async function getManualPaymentView(pool: pg.Pool, storage: StorageAdapter | undefined, token: string): Promise<ManualPaymentView | null> {
  return publicCtx(pool, token, async (db, b) => {
    const [p] = await db.select({ id: schema.payments.id, status: schema.payments.status, amountIdr: schema.payments.amountIdr, expiresAt: schema.payments.expiresAt, provider: schema.payments.provider }).from(schema.payments).where(and(eq(schema.payments.subjectType, b.type), eq(schema.payments.subjectId, b.id))).orderBy(desc(schema.payments.createdAt)).limit(1);
    if (!p || p.provider !== "manual") return null;
    const methods = await db.select().from(schema.paymentMethods).orderBy(asc(schema.paymentMethods.sortOrder), asc(schema.paymentMethods.createdAt));
    const view = await asWorker(db, async (w) => {
      const urls = new Map<string, string>();
      if (storage) {
        for (const m of methods) {
          if (!m.qrisFileId) continue;
          const [f] = await w.select({ storageKey: schema.files.storageKey, filename: schema.files.filename, status: schema.files.status }).from(schema.files).where(eq(schema.files.id, m.qrisFileId)).limit(1);
          if (f && f.status === "ready") urls.set(m.id, await storage.presignDownload({ key: f.storageKey, filename: f.filename }));
        }
      }
      const [proof] = await w.select({ status: schema.paymentProofs.status, rejectReason: schema.paymentProofs.rejectReason, submittedAt: schema.paymentProofs.submittedAt }).from(schema.paymentProofs).where(and(eq(schema.paymentProofs.paymentId, p.id), ne(schema.paymentProofs.status, "draft"))).orderBy(desc(schema.paymentProofs.submittedAt)).limit(1);
      return { urls, proof: proof ?? null };
    });
    return {
      payment: { id: p.id, status: p.status, amountIdr: p.amountIdr, expiresAt: p.expiresAt },
      methods: methods.filter((m) => m.active).map((m) => ({ id: m.id, kind: m.kind, label: m.label, accountName: m.accountName, accountNumber: m.accountNumber, instructions: m.instructions, qrisUrl: view.urls.get(m.id) ?? null })),
      proof: view.proof,
      canUpload: p.status === "pending" && b.status === "pending",
    };
  });
}

/** Minta URL unggah untuk bukti. Dibatasi: gambar/PDF ≤ 5 MB, maks 5 bukti per pembayaran, 10 permintaan per hari per token. */
export async function requestProofUpload(pool: pg.Pool, storage: StorageAdapter, token: string, req: { filename: string; mime: string; sizeBytes: number }) {
  if (!PROOF_MIMES.includes(req.mime.trim().toLowerCase())) throw new AppError("invalid_input", "Bukti harus berupa gambar (PNG/JPG/WebP) atau PDF.");
  if (!Number.isInteger(req.sizeBytes) || req.sizeBytes <= 0 || req.sizeBytes > PROOF_MAX_BYTES) throw new AppError("invalid_input", "Ukuran bukti maksimal 5 MB.");
  await consumeRateLimit(pool, rateKey("proof", hashToken(token)), { limit: 10, windowSec: 86400, message: "Terlalu banyak unggahan hari ini. Coba lagi besok." });
  const res = await publicCtx(pool, token, async (db, b) => {
    const [p] = await db.select({ id: schema.payments.id, status: schema.payments.status, provider: schema.payments.provider }).from(schema.payments).where(and(eq(schema.payments.subjectType, b.type), eq(schema.payments.subjectId, b.id))).limit(1);
    if (!p || p.provider !== "manual" || p.status !== "pending" || b.status !== "pending") throw new AppError("invalid_input", "Pembayaran ini sedang tidak menerima bukti.");
    return asWorker(db, async (w) => {
      const [{ n } = { n: 0 }] = await w.select({ n: sql<number>`count(*)::int` }).from(schema.paymentProofs).where(eq(schema.paymentProofs.paymentId, p.id));
      if (n >= MAX_PROOFS_PER_PAYMENT) throw new AppError("rate_limited", "Batas unggah bukti tercapai. Hubungi penyedia jasa.");
      const created = await createPendingFile(w, { workspaceId: b.workspaceId }, storage, null, req);
      // Mengikat berkas ke pembayaran ini: berkas hanya bisa dikirim sebagai bukti untuk pembayaran yang memintanya.
      await w.insert(schema.paymentProofs).values({ workspaceId: b.workspaceId, paymentId: p.id, fileId: created.fileId, status: "draft" });
      return created;
    });
  });
  if (!res) throw new AppError("not_found", "Pesanan tidak ditemukan.");
  return res;
}

/** Kirim bukti yang sudah diunggah: berkas diverifikasi, pembayaran → 'awaiting_verification', staf diberi tahu. */
export async function submitProof(pool: pg.Pool, storage: StorageAdapter, token: string, fileId: string, note: string | undefined, opts: { baseUrl: string; now?: Date }) {
  const now = opts.now ?? new Date();
  const cleanNote = note?.replace(/\s+/g, " ").trim().slice(0, 300) || null;
  const out = await publicCtx(pool, token, async (db, b) => {
    const r = await asWorker(db, async (w) => {
      const p = await lockPayment(w, and(eq(schema.payments.subjectType, b.type), eq(schema.payments.subjectId, b.id), eq(schema.payments.provider, "manual")));
      if (!p || p.status !== "pending" || b.status !== "pending") throw new AppError("invalid_input", "Pembayaran ini sedang tidak menerima bukti.");
      const [draft] = await w.select({ id: schema.paymentProofs.id }).from(schema.paymentProofs).where(and(eq(schema.paymentProofs.paymentId, p.id), eq(schema.paymentProofs.fileId, fileId), eq(schema.paymentProofs.status, "draft"))).limit(1);
      if (!draft) throw new AppError("not_found", "Berkas bukti tidak ditemukan atau sudah dikirim.");
      const fin = await finalizeFile(w, storage, fileId);
      if (!fin.ok) return { rejected: fin.reason } as const;
      await w.update(schema.paymentProofs).set({ status: "submitted", note: cleanNote, submittedAt: now }).where(eq(schema.paymentProofs.id, draft.id));
      await transition(w, p, "awaiting_verification", "api", { proofFileId: fileId }, {}, now);
      return { paymentId: p.id, amountIdr: p.amountIdr } as const;
    });
    if ("rejected" in r) return r;
    await audit(db, { workspaceId: b.workspaceId, actorUserId: null, action: "payment.proof_submitted", entityType: "payment", entityId: r.paymentId });
    await notifyStaff(db, b.workspaceId, { assigneeMemberId: b.memberId }, (to) => ({
      to,
      subject: `Bukti pembayaran baru: ${b.title}`,
      heading: "Ada bukti pembayaran yang perlu diverifikasi",
      paragraphs: [`${b.title} — Rp${r.amountIdr.toLocaleString("id-ID")}`, "Periksa bukti, cocokkan dengan mutasi rekening Anda, lalu konfirmasi atau tolak."],
      ctaLabel: "Buka verifikasi pembayaran",
      url: `${opts.baseUrl.replace(/\/$/, "")}/w/${b.wsSlug}/pembayaran`,
      dedupeKey: `payment:${r.paymentId}:proof:${fileId}:${to}`,
    }));
    return r;
  });
  if (!out) throw new AppError("not_found", "Pesanan tidak ditemukan.");
  if ("rejected" in out && out.rejected) throw new AppError("invalid_input", out.rejected);
  return { paymentId: (out as { paymentId: string }).paymentId };
}

// --- Sisi staf: antrean verifikasi --------------------------------------------------------------------

export interface ReviewRow {
  paymentId: string;
  status: string;
  amountIdr: number;
  expiresAt: Date;
  createdAt: Date;
  bookingId: string;
  /** Apa yang dibayar: janji temu (booking) atau sewa (reservation). */
  subjectType: string;
  startsAt: Date | null;
  typeTitle: string | null;
  clientName: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  proof: { id: string; note: string | null; status: string; rejectReason: string | null; submittedAt: Date; mime: string | null } | null;
}

/** Daftar pembayaran manual: `open` = menunggu bukti/verifikasi, `all` = semua (100 terbaru). */
export async function listManualPayments(pool: pg.Pool, actor: Actor, filter: "open" | "all" = "open"): Promise<ReviewRow[]> {
  return withWorkspace(pool, actor, "staff", async (db) => {
    const rows = await db
      .select({ paymentId: schema.payments.id, status: schema.payments.status, amountIdr: schema.payments.amountIdr, expiresAt: schema.payments.expiresAt, createdAt: schema.payments.createdAt, bookingId: schema.payments.subjectId, subjectType: schema.payments.subjectType, startsAt: sql<Date | null>`coalesce(${schema.bookings.startsAt}, lower(${schema.reservations.during}))`, typeTitle: sql<string | null>`coalesce(${schema.meetingTypes.title}, ${schema.resources.name})`, clientName: schema.workspaceClients.name, clientEmail: schema.workspaceClients.email, clientPhone: schema.workspaceClients.phone })
      .from(schema.payments)
      .leftJoin(schema.bookings, and(eq(schema.bookings.id, schema.payments.subjectId), eq(schema.payments.subjectType, "booking")))
      .leftJoin(schema.meetingTypes, eq(schema.meetingTypes.id, schema.bookings.meetingTypeId))
      .leftJoin(schema.reservations, and(eq(schema.reservations.id, schema.payments.subjectId), eq(schema.payments.subjectType, "reservation")))
      .leftJoin(schema.resources, eq(schema.resources.id, schema.reservations.resourceId))
      .leftJoin(schema.workspaceClients, eq(schema.workspaceClients.id, sql`coalesce(${schema.bookings.clientId}, ${schema.reservations.clientId})`))
      .where(and(eq(schema.payments.provider, "manual"), filter === "open" ? inArray(schema.payments.status, ["pending", "awaiting_verification"]) : sql`true`))
      .orderBy(sql`(${schema.payments.status} = 'awaiting_verification') desc`, desc(schema.payments.createdAt))
      .limit(100);
    const ids = rows.map((r) => r.paymentId);
    const proofs = ids.length
      ? await db
          .select({ id: schema.paymentProofs.id, paymentId: schema.paymentProofs.paymentId, note: schema.paymentProofs.note, status: schema.paymentProofs.status, rejectReason: schema.paymentProofs.rejectReason, submittedAt: schema.paymentProofs.submittedAt, mime: schema.files.mime })
          .from(schema.paymentProofs)
          .leftJoin(schema.files, eq(schema.files.id, schema.paymentProofs.fileId))
          .where(and(inArray(schema.paymentProofs.paymentId, ids), ne(schema.paymentProofs.status, "draft")))
          .orderBy(desc(schema.paymentProofs.submittedAt))
      : [];
    return rows.map((r) => {
      const pr = proofs.find((x) => x.paymentId === r.paymentId);
      return { ...r, startsAt: r.startsAt ? new Date(r.startsAt) : null, proof: pr ? { id: pr.id, note: pr.note, status: pr.status, rejectReason: pr.rejectReason, submittedAt: pr.submittedAt, mime: pr.mime ?? null } : null };
    });
  });
}

/** URL unduh bukti (berumur pendek). Hanya staf workspace; tercatat di audit. */
export async function getProofDownloadUrl(pool: pg.Pool, actor: Actor, storage: StorageAdapter, proofId: string) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const [pr] = await db.select({ fileId: schema.paymentProofs.fileId }).from(schema.paymentProofs).where(eq(schema.paymentProofs.id, proofId)).limit(1);
    if (!pr) throw new AppError("not_found", "Bukti tidak ditemukan.");
    return signDownload(db, access, storage, actor.userId, pr.fileId);
  });
}

export type ReviewDecision = { accept: true } | { accept: false; reason: string };

/**
 * Staf mengonfirmasi lunas (dari bukti, atau langsung untuk pembayaran tunai/di luar sistem) atau menolak bukti.
 * `lateBooking: true` = pembayaran diterima tetapi booking-nya sudah dilepas/dibatalkan: staf perlu mengembalikan dana.
 */
export async function reviewPayment(deps: PaymentDeps, actor: Actor, paymentId: string, decision: ReviewDecision, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (!decision.accept) {
    const reason = decision.reason.replace(/\s+/g, " ").trim();
    if (reason.length < 3 || reason.length > 200) throw new AppError("invalid_input", "Alasan penolakan 3–200 karakter.");
    decision = { accept: false, reason };
  }
  const rejectReason = decision.accept ? "" : decision.reason;
  return withWorkspace(deps.pool, actor, "staff", async (db, access) => {
    const [vis] = await db.select({ id: schema.payments.id }).from(schema.payments).where(and(eq(schema.payments.id, paymentId), eq(schema.payments.provider, "manual"))).limit(1);
    if (!vis) throw new AppError("not_found", "Pembayaran tidak ditemukan.");
    const result = await asWorker(db, async (w) => {
      const p = await lockPayment(w, eq(schema.payments.id, paymentId));
      if (!p || p.provider !== "manual") throw new AppError("not_found", "Pembayaran tidak ditemukan.");
      const [latest] = await w.select({ id: schema.paymentProofs.id }).from(schema.paymentProofs).where(and(eq(schema.paymentProofs.paymentId, p.id), eq(schema.paymentProofs.status, "submitted"))).orderBy(desc(schema.paymentProofs.submittedAt)).limit(1);
      if (decision.accept) {
        if (p.status !== "awaiting_verification" && p.status !== "pending") throw new AppError("invalid_input", "Pembayaran ini tidak dapat dikonfirmasi pada status sekarang.");
        if (latest) await w.update(schema.paymentProofs).set({ status: "accepted", reviewedBy: actor.userId, reviewedAt: now }).where(eq(schema.paymentProofs.id, latest.id));
        await transition(w, p, "paid", "admin", { reviewer: actor.userId, proofId: latest?.id ?? null }, { paidAt: now }, now);
        const r = await confirmSubject(w, deps, p);
        return { status: "paid" as const, lateBooking: r === "late" };
      }
      if (p.status !== "awaiting_verification") throw new AppError("invalid_input", "Hanya bukti yang menunggu verifikasi yang bisa ditolak.");
      if (latest) await w.update(schema.paymentProofs).set({ status: "rejected", rejectReason, reviewedBy: actor.userId, reviewedAt: now }).where(eq(schema.paymentProofs.id, latest.id));
      await transition(w, p, "pending", "admin", { reviewer: actor.userId, rejected: rejectReason }, { expiresAt: new Date(now.getTime() + REJECT_EXTENSION_MIN * 60_000) }, now);
      const [b] = p.subjectType === "reservation"
        ? await w.select({ clientId: schema.reservations.clientId, workspaceId: schema.reservations.workspaceId }).from(schema.reservations).where(eq(schema.reservations.id, p.subjectId)).limit(1)
        : await w.select({ clientId: schema.bookings.clientId, workspaceId: schema.bookings.workspaceId }).from(schema.bookings).where(eq(schema.bookings.id, p.subjectId)).limit(1);
      const [c] = b ? await w.select({ email: schema.workspaceClients.email }).from(schema.workspaceClients).where(eq(schema.workspaceClients.id, b.clientId)).limit(1) : [];
      if (c?.email) {
        await notifyEmails(w, p.workspaceId, [{ to: c.email, subject: "Bukti pembayaran belum dapat diterima", heading: "Bukti pembayaran Anda belum dapat diterima", paragraphs: [`Alasan: ${rejectReason}`, `Anda punya waktu ${REJECT_EXTENSION_MIN} menit untuk mengunggah ulang bukti lewat tautan di email pesanan Anda.`], ctaLabel: "Buka jadwalin.id", url: "https://jadwalin.id", dedupeKey: `payment:${p.id}:rejected:${now.getTime()}` }]);
      }
      return { status: "pending" as const, lateBooking: false };
    });
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: decision.accept ? "payment.confirmed_manual" : "payment.proof_rejected", entityType: "payment", entityId: paymentId, diff: decision.accept ? { lateBooking: result.lateBooking } : { reason: rejectReason } });
    return result;
  });
}

// --- Pembatalan oleh pemesan/pemilik ----------------------------------------------------------------------

/**
 * Pesanan dibatalkan/ditolak: pembayaran manual yang masih terbuka (menunggu bukti / verifikasi) ikut dibatalkan lewat state machine.
 * Pembayaran yang sudah 'paid' TIDAK disentuh (dana sudah diterima penyedia; pengembalian dilakukan manual). Mengembalikan status terakhir.
 */
export async function cancelOpenManualPayment(db: Db, subject: { type: "booking" | "reservation"; id: string }, source: "api" | "admin", now = new Date()): Promise<string | null> {
  return asWorker(db, async (w) => {
    const p = await lockPayment(w, and(eq(schema.payments.subjectType, subject.type), eq(schema.payments.subjectId, subject.id), eq(schema.payments.provider, "manual")));
    if (!p) return null;
    if (p.status === "pending" || p.status === "awaiting_verification") {
      await transition(w, p, "cancelled", source, { reason: "order_cancelled" }, {}, now);
      return "cancelled";
    }
    return p.status;
  });
}

/** Status pembayaran manual per subjek (untuk daftar pesanan sewa): subjectId → { status, amountIdr }. */
export async function paymentStatusBySubject(db: Db, type: "booking" | "reservation", ids: string[]): Promise<Map<string, { status: string; amountIdr: number }>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ subjectId: schema.payments.subjectId, status: schema.payments.status, amountIdr: schema.payments.amountIdr }).from(schema.payments).where(and(eq(schema.payments.subjectType, type), eq(schema.payments.provider, "manual"), inArray(schema.payments.subjectId, ids))).orderBy(asc(schema.payments.createdAt));
  const m = new Map<string, { status: string; amountIdr: number }>();
  for (const r of rows) m.set(r.subjectId, { status: r.status, amountIdr: r.amountIdr });
  return m;
}
