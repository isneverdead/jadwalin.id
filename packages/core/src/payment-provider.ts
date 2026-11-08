import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderEventKind } from "./payment-state";

/**
 * Antarmuka penyedia pembayaran (ADR 0001). Inti tidak mengenal Midtrans/Xendit; adapter menerjemahkan.
 * Uang selalu integer Rupiah. Tanda tangan notifikasi diverifikasi SEBELUM apa pun disimpan.
 */
export interface CreateChargeInput {
  orderId: string;
  amountIdr: number;
  expiresAt: Date;
  now: Date;
  customer: { name: string; email?: string | null };
  description: string;
  /** Id merchant/sub-account milik penyedia jasa (dana ke sana, bukan ke jadwalin). */
  providerAccountId: string;
}
export interface Charge {
  checkoutUrl: string;
}
export interface VerifiedNotification {
  /** Id unik kejadian untuk idempotensi `webhook_inbox`. */
  eventId: string;
  orderId: string;
  kind: ProviderEventKind;
  amountIdr: number;
  raw: unknown;
}
export interface RefundInput {
  orderId: string;
  amountIdr: number;
  /** Kunci idempoten: refund yang sama tak diproses dua kali oleh penyedia. */
  key: string;
  reason?: string;
}
export interface PaymentProvider {
  readonly name: string;
  /** 'split' = dana langsung terpisah ke akun penyedia jasa; 'own_account' = merchant penyedia jasa sendiri. Tak ada mode "ditampung jadwalin". */
  readonly settlement: "split" | "own_account";
  createCharge(input: CreateChargeInput): Promise<Charge>;
  /** Lempar bila tanda tangan/format tidak valid. */
  verifyNotification(rawBody: string, headers: Record<string, string | undefined>): VerifiedNotification;
  fetchStatus(orderId: string): Promise<{ kind: ProviderEventKind; amountIdr: number } | null>;
  refund(input: RefundInput): Promise<{ ok: boolean; reason?: string }>;
}

export class NotificationError extends Error {}

/** "10000" atau "10000.00" → 10000. Pecahan selain .00 ditolak: uang tidak pernah float. */
export function parseIdrAmount(value: unknown): number {
  const m = /^(\d{1,15})(?:\.0{1,2})?$/.exec(String(value ?? ""));
  if (!m) throw new NotificationError("Nominal tidak valid.");
  return Number(m[1]);
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

// --- Fake: deterministik, untuk tes dan staging lokal ----------------------------------------------

export interface FakeCharge extends CreateChargeInput {
  status: ProviderEventKind;
}
export class FakeProvider implements PaymentProvider {
  readonly name = "fake";
  readonly settlement = "split" as const;
  charges = new Map<string, FakeCharge>();
  refunds: RefundInput[] = [];
  failCreate = false;
  failRefund = false;
  constructor(private readonly secret: string) {}

  async createCharge(input: CreateChargeInput): Promise<Charge> {
    if (this.failCreate) throw new Error("penyedia tidak tersedia");
    this.charges.set(input.orderId, { ...input, status: "pending" });
    return { checkoutUrl: `https://pay.fake.local/${input.orderId}` };
  }

  /** Bangun badan + header notifikasi bertanda tangan seperti yang dikirim penyedia sungguhan. */
  signedNotification(n: { orderId: string; kind: ProviderEventKind; amountIdr: number; eventId?: string }) {
    const body = JSON.stringify({ event_id: n.eventId ?? `${n.orderId}:${n.kind}`, order_id: n.orderId, status: n.kind, amount: n.amountIdr });
    return { body, headers: { "x-fake-signature": createHmac("sha256", this.secret).update(body).digest("hex") } };
  }

  verifyNotification(rawBody: string, headers: Record<string, string | undefined>): VerifiedNotification {
    const expected = createHmac("sha256", this.secret).update(rawBody).digest("hex");
    if (!safeEqualHex(expected, headers["x-fake-signature"] ?? "")) throw new NotificationError("Tanda tangan tidak valid.");
    let j: { event_id?: string; order_id?: string; status?: ProviderEventKind; amount?: number };
    try {
      j = JSON.parse(rawBody);
    } catch {
      throw new NotificationError("Badan bukan JSON.");
    }
    if (!j.event_id || !j.order_id || !j.status) throw new NotificationError("Notifikasi tidak lengkap.");
    return { eventId: j.event_id, orderId: j.order_id, kind: j.status, amountIdr: parseIdrAmount(j.amount), raw: j };
  }

  async fetchStatus(orderId: string) {
    const c = this.charges.get(orderId);
    return c ? { kind: c.status, amountIdr: c.amountIdr } : null;
  }

  async refund(input: RefundInput) {
    if (this.failRefund) return { ok: false, reason: "ditolak penyedia" };
    if (!this.refunds.some((r) => r.key === input.key)) this.refunds.push(input);
    return { ok: true };
  }
}

// --- Midtrans (Snap + notifikasi HTTP + Status/Refund API) ------------------------------------------

export interface MidtransOptions {
  serverKey: string;
  environment: "sandbox" | "production";
  fetchImpl?: typeof fetch;
}
const MIDTRANS = {
  sandbox: { snap: "https://app.sandbox.midtrans.com/snap/v1/transactions", api: "https://api.sandbox.midtrans.com/v2" },
  production: { snap: "https://app.midtrans.com/snap/v1/transactions", api: "https://api.midtrans.com/v2" },
} as const;

export function midtransKind(status: string, fraud?: string): ProviderEventKind | null {
  switch (status) {
    case "capture":
      return fraud === "accept" || fraud === undefined ? "paid" : "pending";
    case "settlement":
      return "paid";
    case "pending":
      return "pending";
    case "deny":
    case "failure":
      return "failed";
    case "cancel":
      return "cancelled";
    case "expire":
      return "expired";
    case "refund":
      return "refunded";
    case "partial_refund":
      return "partially_refunded";
    default:
      return null;
  }
}

export class MidtransProvider implements PaymentProvider {
  readonly name = "midtrans";
  /** Setiap workspace memakai merchant Midtrans sendiri (dana tidak melewati jadwalin); lihat ADR 0001. */
  readonly settlement = "own_account" as const;
  private readonly f: typeof fetch;
  constructor(private readonly opts: MidtransOptions) {
    this.f = opts.fetchImpl ?? fetch;
  }
  private auth() {
    return `Basic ${Buffer.from(`${this.opts.serverKey}:`).toString("base64")}`;
  }
  private async call(url: string, init: RequestInit & { body?: string }) {
    const res = await this.f(url, { ...init, headers: { accept: "application/json", "content-type": "application/json", authorization: this.auth() }, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* respons non-JSON ditangani oleh pemanggil lewat status */
    }
    return { status: res.status, json };
  }

  async createCharge(input: CreateChargeInput): Promise<Charge> {
    const minutes = Math.max(1, Math.ceil((input.expiresAt.getTime() - input.now.getTime()) / 60_000));
    const { status, json } = await this.call(MIDTRANS[this.opts.environment].snap, {
      method: "POST",
      body: JSON.stringify({
        transaction_details: { order_id: input.orderId, gross_amount: input.amountIdr },
        expiry: { unit: "minutes", duration: minutes },
        customer_details: { first_name: input.customer.name.slice(0, 50), ...(input.customer.email ? { email: input.customer.email } : {}) },
        item_details: [{ id: input.orderId.slice(0, 50), price: input.amountIdr, quantity: 1, name: input.description.slice(0, 50) }],
      }),
    });
    const url = typeof json.redirect_url === "string" ? json.redirect_url : null;
    if (status >= 300 || !url) throw new Error(`Midtrans menolak pembuatan transaksi (HTTP ${status}).`);
    return { checkoutUrl: url };
  }

  verifyNotification(rawBody: string): VerifiedNotification {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new NotificationError("Badan bukan JSON.");
    }
    const orderId = String(j.order_id ?? "");
    const statusCode = String(j.status_code ?? "");
    const gross = String(j.gross_amount ?? "");
    const signature = String(j.signature_key ?? "");
    if (!orderId || !statusCode || !gross || !signature) throw new NotificationError("Notifikasi tidak lengkap.");
    const expected = createHash("sha512").update(orderId + statusCode + gross + this.opts.serverKey).digest("hex");
    if (!safeEqualHex(expected, signature)) throw new NotificationError("Tanda tangan tidak valid.");
    const transactionStatus = String(j.transaction_status ?? "");
    const kind = midtransKind(transactionStatus, j.fraud_status === undefined ? undefined : String(j.fraud_status));
    if (!kind) throw new NotificationError(`Status transaksi tak dikenal: ${transactionStatus}`);
    const eventId = `${String(j.transaction_id ?? orderId)}:${transactionStatus}:${statusCode}`;
    return { eventId, orderId, kind, amountIdr: parseIdrAmount(gross), raw: { order_id: orderId, transaction_status: transactionStatus, status_code: statusCode, gross_amount: gross, transaction_id: j.transaction_id ?? null, fraud_status: j.fraud_status ?? null } };
  }

  async fetchStatus(orderId: string) {
    const { status, json } = await this.call(`${MIDTRANS[this.opts.environment].api}/${encodeURIComponent(orderId)}/status`, { method: "GET" });
    if (status === 404 || String(json.status_code) === "404") return null;
    if (status >= 300) throw new Error(`Midtrans status gagal (HTTP ${status}).`);
    const kind = midtransKind(String(json.transaction_status ?? ""), json.fraud_status === undefined ? undefined : String(json.fraud_status));
    return kind ? { kind, amountIdr: parseIdrAmount(json.gross_amount) } : null;
  }

  async refund(input: RefundInput) {
    const { status, json } = await this.call(`${MIDTRANS[this.opts.environment].api}/${encodeURIComponent(input.orderId)}/refund`, {
      method: "POST",
      body: JSON.stringify({ refund_key: input.key, amount: input.amountIdr, reason: input.reason ?? "refund" }),
    });
    const code = String(json.status_code ?? status);
    return code.startsWith("2") ? { ok: true } : { ok: false, reason: `Midtrans ${code}` };
  }
}

export type ProviderConfig = { provider: "fake"; fakeSecret: string } | { provider: "midtrans"; serverKey: string; environment: "sandbox" | "production" };
export function createPaymentProvider(cfg: ProviderConfig): PaymentProvider {
  return cfg.provider === "fake" ? new FakeProvider(cfg.fakeSecret) : new MidtransProvider({ serverKey: cfg.serverKey, environment: cfg.environment });
}
