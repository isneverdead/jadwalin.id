import { schema, withWorker, type Db } from "@jadwalin/db";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type pg from "pg";
import { getLimits } from "./entitlements";
import { AppError } from "./errors";
import { NotificationError, type PaymentProvider } from "./payment-provider";
import { assertTransition, nextStatus, type PaymentStatus, type ProviderEventKind } from "./payment-state";
import { withWorkspace, type Actor } from "./workspace";

/**
 * Layanan pembayaran inti (ADR 0001). Semua penulisan lewat role worker; setiap transisi status menulis `payment_events`
 * di transaksi yang sama (aturan #10). Panggilan jaringan ke penyedia TIDAK dilakukan di dalam transaksi basis data.
 */
export const PAYMENT_TTL_MIN = 30;
export type Source = "webhook" | "api" | "reconcile" | "admin" | "system";
export type PaymentRow = typeof schema.payments.$inferSelect;
export type PaymentSource = Source;

export interface PaymentHooks {
  /** Dipanggil di transaksi yang sama saat booking dikonfirmasi oleh pembayaran (mis. mengantre email konfirmasi). */
  bookingConfirmed?(db: Db, p: PaymentRow): Promise<void>;
  /** Booking dilepas karena pembayaran gagal/kedaluwarsa/dibatalkan. */
  bookingReleased?(db: Db, p: PaymentRow, reason: PaymentStatus): Promise<void>;
  /** Reservasi (sewa) dikonfirmasi oleh DP yang diverifikasi. */
  reservationConfirmed?(db: Db, p: PaymentRow): Promise<void>;
  /** Reservasi (sewa) dilepas karena DP kedaluwarsa/dibatalkan. */
  reservationReleased?(db: Db, p: PaymentRow, reason: PaymentStatus): Promise<void>;
}

export interface PaymentDeps {
  pool: pg.Pool;
  provider: PaymentProvider;
  hooks?: PaymentHooks;
  now?: () => Date;
}
const nowOf = (d: PaymentDeps) => (d.now ? d.now() : new Date());

/** Satu-satunya tempat status pembayaran berubah: memeriksa state machine, mengunci baris, menulis event. */
export async function transition(db: Db, p: PaymentRow, to: PaymentStatus, source: Source, raw: unknown, patch: Partial<typeof schema.payments.$inferInsert> = {}, now = new Date()): Promise<boolean> {
  assertTransition(p.status as PaymentStatus, to);
  const updated = await db
    .update(schema.payments)
    .set({ status: to, updatedAt: now, ...patch })
    .where(and(eq(schema.payments.id, p.id), eq(schema.payments.status, p.status)))
    .returning({ id: schema.payments.id });
  if (updated.length === 0) return false; // keadaan berubah oleh proses lain; jangan menulis event ganda
  await db.insert(schema.paymentEvents).values({ workspaceId: p.workspaceId, paymentId: p.id, fromStatus: p.status, toStatus: to, source, raw: raw ?? null });
  p.status = to;
  return true;
}

export async function lockPayment(db: Db, where: ReturnType<typeof and>): Promise<PaymentRow | undefined> {
  const [row] = await db.select().from(schema.payments).where(where).for("update").limit(1);
  return row;
}

// --- Membuat pembayaran -----------------------------------------------------------------------------

export interface CreatePaymentInput {
  workspaceId: string;
  subjectType: "booking";
  subjectId: string;
  amountIdr: number;
  idempotencyKey: string;
  customer: { name: string; email?: string | null };
  description: string;
}

/** Membuat pembayaran + transaksi di penyedia. Idempoten per (workspace, idempotencyKey). */
export async function createPayment(deps: PaymentDeps, input: CreatePaymentInput): Promise<{ paymentId: string; checkoutUrl: string; status: PaymentStatus }> {
  const now = nowOf(deps);
  if (!Number.isSafeInteger(input.amountIdr) || input.amountIdr < 1000) throw new AppError("invalid_input", "Nominal pembayaran minimal Rp1.000.");
  const limits = await getLimits(input.workspaceId);
  const fee = Math.floor((input.amountIdr * limits.platformFeeBps) / 10_000);

  const prepared = await withWorker(deps.pool, async (db) => {
    const [account] = await db.select().from(schema.paymentAccounts).where(and(eq(schema.paymentAccounts.workspaceId, input.workspaceId), eq(schema.paymentAccounts.provider, deps.provider.name)));
    // Aturan #3: tanpa akun penyedia jasa yang terverifikasi, dana tak punya tujuan selain jadwalin — tolak.
    if (!account || account.kycStatus !== "verified") throw new AppError("payment_unavailable", "Pembayaran online belum aktif untuk penyedia jasa ini.");
    const [existing] = await db.select().from(schema.payments).where(and(eq(schema.payments.workspaceId, input.workspaceId), eq(schema.payments.idempotencyKey, input.idempotencyKey)));
    if (existing) return { payment: existing, account, fresh: false };
    const id = crypto.randomUUID();
    const [payment] = await db
      .insert(schema.payments)
      .values({ id, workspaceId: input.workspaceId, provider: deps.provider.name, providerRef: id, amountIdr: input.amountIdr, platformFeeIdr: fee, subjectType: input.subjectType, subjectId: input.subjectId, idempotencyKey: input.idempotencyKey, expiresAt: new Date(now.getTime() + PAYMENT_TTL_MIN * 60_000) })
      .returning();
    await db.insert(schema.paymentEvents).values({ workspaceId: input.workspaceId, paymentId: id, fromStatus: null, toStatus: "created", source: "api", raw: null });
    return { payment: payment!, account, fresh: true };
  });

  if (!prepared.fresh) {
    if (!prepared.payment.checkoutUrl) throw new AppError("payment_failed", "Pembayaran sedang diproses. Coba lagi sebentar.");
    return { paymentId: prepared.payment.id, checkoutUrl: prepared.payment.checkoutUrl, status: prepared.payment.status as PaymentStatus };
  }

  // Panggilan penyedia di luar transaksi.
  let checkoutUrl: string;
  try {
    ({ checkoutUrl } = await deps.provider.createCharge({ orderId: prepared.payment.providerRef, amountIdr: input.amountIdr, expiresAt: prepared.payment.expiresAt, now, customer: input.customer, description: input.description, providerAccountId: prepared.account.providerAccountId }));
  } catch (error) {
    await withWorker(deps.pool, async (db) => {
      const p = await lockPayment(db, eq(schema.payments.id, prepared.payment.id));
      if (p && p.status === "created") {
        await transition(db, p, "failed", "api", { error: "createCharge" }, {}, now);
        await releaseSubject(db, deps, p, "failed");
      }
    });
    throw new AppError("payment_failed", "Pembayaran tidak dapat dibuat sekarang. Silakan coba lagi.");
  }
  await withWorker(deps.pool, async (db) => {
    const p = await lockPayment(db, eq(schema.payments.id, prepared.payment.id));
    if (p && p.status === "created") await transition(db, p, "pending", "api", null, { checkoutUrl }, now);
  });
  return { paymentId: prepared.payment.id, checkoutUrl, status: "pending" };
}

// --- Efek pada subjek (booking) ---------------------------------------------------------------------

export async function confirmSubject(db: Db, deps: PaymentDeps, p: PaymentRow): Promise<"confirmed" | "late"> {
  if (p.subjectType === "reservation") {
    const done = await db.update(schema.reservations).set({ status: "confirmed" }).where(and(eq(schema.reservations.id, p.subjectId), eq(schema.reservations.status, "pending"))).returning({ id: schema.reservations.id });
    if (done.length === 0) return "late"; // pesanan sudah dilepas: DP masuk TERLAMBAT
    await deps.hooks?.reservationConfirmed?.(db, p);
    return "confirmed";
  }
  if (p.subjectType !== "booking") return "confirmed";
  const updated = await db.update(schema.bookings).set({ status: "confirmed" }).where(and(eq(schema.bookings.id, p.subjectId), eq(schema.bookings.status, "pending"))).returning({ id: schema.bookings.id });
  if (updated.length === 0) return "late"; // booking sudah dilepas (kedaluwarsa/dibatalkan): dana masuk TERLAMBAT
  await deps.hooks?.bookingConfirmed?.(db, p);
  return "confirmed";
}

export async function releaseSubject(db: Db, deps: PaymentDeps, p: PaymentRow, reason: PaymentStatus): Promise<void> {
  if (p.subjectType === "reservation") {
    const done = await db.update(schema.reservations).set({ status: "cancelled" }).where(and(eq(schema.reservations.id, p.subjectId), eq(schema.reservations.status, "pending"))).returning({ id: schema.reservations.id });
    if (done.length > 0) await deps.hooks?.reservationReleased?.(db, p, reason);
    return;
  }
  if (p.subjectType !== "booking") return;
  const updated = await db.update(schema.bookings).set({ status: "cancelled" }).where(and(eq(schema.bookings.id, p.subjectId), eq(schema.bookings.status, "pending"))).returning({ id: schema.bookings.id });
  if (updated.length > 0) await deps.hooks?.bookingReleased?.(db, p, reason);
}

/** Terapkan kejadian penyedia pada pembayaran terkunci. Mengembalikan true bila status berubah. */
async function applyKind(db: Db, deps: PaymentDeps, p: PaymentRow, kind: ProviderEventKind, source: Source, raw: unknown, now: Date): Promise<{ changed: boolean; autoRefund: boolean }> {
  const to = nextStatus(p.status as PaymentStatus, kind);
  if (!to) return { changed: false, autoRefund: false };
  const patch: Partial<typeof schema.payments.$inferInsert> = to === "paid" ? { paidAt: now } : to === "refunded" ? { refundedIdr: p.amountIdr } : {};
  if (!(await transition(db, p, to, source, raw, patch, now))) return { changed: false, autoRefund: false };
  if (to === "paid") {
    const r = await confirmSubject(db, deps, p);
    return { changed: true, autoRefund: r === "late" };
  }
  if (to === "expired" || to === "failed" || to === "cancelled") await releaseSubject(db, deps, p, to);
  return { changed: true, autoRefund: false };
}

// --- Webhook ----------------------------------------------------------------------------------------

export type WebhookResult = "processed" | "duplicate" | "ignored" | "rejected";

/**
 * Memproses notifikasi penyedia. Tanda tangan diverifikasi dulu (NotificationError → pemanggil membalas 400, tidak disimpan).
 * Idempoten: `webhook_inbox` unik per (penyedia, id event); duplikat → "duplicate". Terlambat/terbalik urutan → "ignored".
 */
export async function processWebhook(deps: PaymentDeps, rawBody: string, headers: Record<string, string | undefined>): Promise<WebhookResult> {
  const n = deps.provider.verifyNotification(rawBody, headers);
  const now = nowOf(deps);
  let autoRefundId: string | null = null;
  const result = await withWorker(deps.pool, async (db): Promise<WebhookResult> => {
    const inserted = await db.insert(schema.webhookInbox).values({ provider: deps.provider.name, eventId: n.eventId, payload: n.raw as object }).onConflictDoNothing().returning({ id: schema.webhookInbox.id });
    if (inserted.length === 0) return "duplicate";
    const inboxId = inserted[0]!.id;
    const finish = async (status: "processed" | "ignored" | "failed", error?: string) => {
      await db.update(schema.webhookInbox).set({ status, error: error ?? null, processedAt: now }).where(eq(schema.webhookInbox.id, inboxId));
    };
    const p = await lockPayment(db, and(eq(schema.payments.provider, deps.provider.name), eq(schema.payments.providerRef, n.orderId)));
    if (!p) {
      await finish("ignored", "pesanan tidak dikenal");
      return "ignored";
    }
    // Nominal pada kejadian 'paid' harus sama persis; selisih = ditolak dan dicatat (jangan percaya notifikasi begitu saja).
    if (n.kind === "paid" && n.amountIdr !== p.amountIdr) {
      await finish("failed", `nominal tidak cocok (${n.amountIdr} != ${p.amountIdr})`);
      return "rejected";
    }
    const r = await applyKind(db, deps, p, n.kind, "webhook", n.raw, now);
    await finish(r.changed ? "processed" : "ignored", r.changed ? undefined : "tidak ada transisi (duplikat/terlambat)");
    if (r.autoRefund) autoRefundId = p.id;
    return r.changed ? "processed" : "ignored";
  });
  if (autoRefundId) await refundPaymentInternal(deps, autoRefundId, undefined, "Pembayaran masuk setelah booking dilepas", "system");
  return result;
}

// --- Refund -----------------------------------------------------------------------------------------

/** Staf (admin ke atas) meminta refund pembayaran di workspace-nya. Nominal kosong = seluruh sisa. */
export async function refundPayment(deps: PaymentDeps, actor: Actor, paymentId: string, amountIdr?: number, reason?: string) {
  await withWorkspace(deps.pool, actor, "admin", async (db) => {
    const [p] = await db.select({ id: schema.payments.id }).from(schema.payments).where(eq(schema.payments.id, paymentId));
    if (!p) throw new AppError("not_found", "Pembayaran tidak ditemukan.");
  });
  return refundPaymentInternal(deps, paymentId, amountIdr, reason ?? "Refund oleh penyedia jasa", "admin");
}

async function refundPaymentInternal(deps: PaymentDeps, paymentId: string, amountIdr: number | undefined, reason: string, source: Source) {
  const now = nowOf(deps);
  const prepared = await withWorker(deps.pool, async (db) => {
    const p = await lockPayment(db, eq(schema.payments.id, paymentId));
    if (!p) throw new AppError("not_found", "Pembayaran tidak ditemukan.");
    if (p.status !== "paid" && p.status !== "partially_refunded") throw new AppError("invalid_input", "Pembayaran ini tidak dapat direfund pada status sekarang.");
    const remaining = p.amountIdr - p.refundedIdr;
    const amount = amountIdr ?? remaining;
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > remaining) throw new AppError("invalid_input", "Nominal refund tidak valid.");
    const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.refunds).where(eq(schema.refunds.paymentId, p.id));
    const key = `${p.id}:${n + 1}`;
    const [refund] = await db.insert(schema.refunds).values({ workspaceId: p.workspaceId, paymentId: p.id, amountIdr: amount, reason, providerRefundKey: key }).returning();
    await transition(db, p, "refund_pending", source, { refundId: refund!.id, amountIdr: amount }, {}, now);
    return { payment: p, refund: refund! };
  });

  let ok = false;
  let failure: string | undefined;
  try {
    const r = await deps.provider.refund({ orderId: prepared.payment.providerRef, amountIdr: prepared.refund.amountIdr, key: prepared.refund.providerRefundKey, reason });
    ok = r.ok;
    failure = r.reason;
  } catch (e) {
    failure = e instanceof Error ? e.message : "galat";
  }

  return withWorker(deps.pool, async (db) => {
    const p = await lockPayment(db, eq(schema.payments.id, paymentId));
    if (!p) throw new AppError("not_found", "Pembayaran tidak ditemukan.");
    if (ok) {
      const total = p.refundedIdr + prepared.refund.amountIdr;
      await db.update(schema.refunds).set({ status: "succeeded" }).where(eq(schema.refunds.id, prepared.refund.id));
      await transition(db, p, total >= p.amountIdr ? "refunded" : "partially_refunded", source, { refundId: prepared.refund.id }, { refundedIdr: total }, now);
      return { ok: true as const, status: p.status as PaymentStatus };
    }
    await db.update(schema.refunds).set({ status: "failed" }).where(eq(schema.refunds.id, prepared.refund.id));
    await transition(db, p, p.refundedIdr > 0 ? "partially_refunded" : "paid", source, { refundId: prepared.refund.id, error: failure ?? "gagal" }, {}, now);
    return { ok: false as const, status: p.status as PaymentStatus };
  });
}

// --- Rekonsiliasi dan kedaluwarsa -------------------------------------------------------------------

/**
 * Menyapu pembayaran yang macet: `created` lebih dari 10 menit (proses mati sebelum memanggil penyedia) → gagal;
 * `pending` melewati batas → tanya status ke penyedia (bila sudah dibayar, tetap diakui) lalu kedaluwarsakan.
 */
export async function reconcilePayments(deps: PaymentDeps): Promise<{ checked: number; changed: number }> {
  const now = nowOf(deps);
  const stale = await withWorker(deps.pool, (db) =>
    db
      .select({ id: schema.payments.id, status: schema.payments.status, providerRef: schema.payments.providerRef })
      .from(schema.payments)
      .where(and(eq(schema.payments.provider, deps.provider.name), inArray(schema.payments.status, ["created", "pending"]), lt(schema.payments.expiresAt, new Date(now.getTime() - (deps.provider.name === "fake" ? 0 : 60_000))))),
  );
  let changed = 0;
  for (const s of stale) {
    let remote: { kind: ProviderEventKind; amountIdr: number } | null = null;
    try {
      remote = await deps.provider.fetchStatus(s.providerRef);
    } catch {
      continue; // penyedia bermasalah: coba lagi pada putaran berikutnya
    }
    const kind: ProviderEventKind = remote && remote.kind !== "pending" ? remote.kind : "expired";
    let autoRefund: string | null = null;
    const did = await withWorker(deps.pool, async (db) => {
      const p = await lockPayment(db, eq(schema.payments.id, s.id));
      if (!p || (p.status !== "created" && p.status !== "pending")) return false;
      if (p.status === "created") {
        // Belum pernah sampai ke penyedia: failed. Bila ternyata ada di penyedia dan lunas, diakui lewat jalur paid.
        const k: ProviderEventKind = remote ? kind : "failed";
        if (k === "paid") {
          await transition(db, p, "pending", "reconcile", null, {}, now);
        } else {
          const r = await applyKindFromCreated(db, deps, p, k, now);
          return r;
        }
      }
      if (kind === "paid" && remote && remote.amountIdr !== p.amountIdr) return false;
      const r = await applyKind(db, deps, p, kind, "reconcile", remote, now);
      if (r.autoRefund) autoRefund = p.id;
      return r.changed;
    });
    if (did) changed++;
    if (autoRefund) await refundPaymentInternal(deps, autoRefund, undefined, "Pembayaran masuk setelah booking dilepas", "system");
  }
  return { checked: stale.length, changed };
}

async function applyKindFromCreated(db: Db, deps: PaymentDeps, p: PaymentRow, kind: ProviderEventKind, now: Date): Promise<boolean> {
  const to: PaymentStatus = kind === "cancelled" ? "cancelled" : "failed";
  if (!(await transition(db, p, to, "reconcile", { from: "created" }, {}, now))) return false;
  await releaseSubject(db, deps, p, to);
  return true;
}

export { NotificationError };
