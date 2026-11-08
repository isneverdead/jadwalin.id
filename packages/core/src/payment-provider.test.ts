import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeProvider, MidtransProvider, NotificationError, midtransKind, parseIdrAmount } from "./payment-provider";

const KEY = "SB-Mid-server-contoh-kunci-uji"; // secret-scan:allow (kunci palsu untuk uji)
const sign = (o: string, c: string, g: string) => createHash("sha512").update(o + c + g + KEY).digest("hex");
const body = (over: Record<string, unknown> = {}) => {
  const base = { order_id: "ord-1", status_code: "200", gross_amount: "150000.00", transaction_status: "settlement", transaction_id: "tx-1", fraud_status: "accept", ...over };
  return JSON.stringify({ ...base, signature_key: sign(String(base.order_id), String(base.status_code), String(base.gross_amount)) });
};

describe("nominal", () => {
  it("menerima bilangan bulat Rupiah dan menolak pecahan/float/format aneh", () => {
    expect(parseIdrAmount("10000")).toBe(10000);
    expect(parseIdrAmount("10000.00")).toBe(10000);
    expect(parseIdrAmount(25000)).toBe(25000);
    for (const bad of ["100.50", "1e5", "-5", "", "abc", "99999999999999999"]) expect(() => parseIdrAmount(bad)).toThrow(NotificationError);
  });
});

describe("Midtrans: notifikasi", () => {
  const p = new MidtransProvider({ serverKey: KEY, environment: "sandbox" });
  it("tanda tangan valid → kejadian ternormalisasi", () => {
    const n = p.verifyNotification(body());
    expect(n).toMatchObject({ orderId: "ord-1", kind: "paid", amountIdr: 150000, eventId: "tx-1:settlement:200" });
  });
  it("tanda tangan salah, nominal diubah, atau kunci lain → ditolak", () => {
    expect(() => p.verifyNotification(body().replace("150000.00", "1.00"))).toThrow(/Tanda tangan/);
    expect(() => new MidtransProvider({ serverKey: "kunci-lain", environment: "sandbox" }).verifyNotification(body())).toThrow(/Tanda tangan/);
    expect(() => p.verifyNotification(JSON.stringify({ order_id: "x" }))).toThrow(/tidak lengkap/);
    expect(() => p.verifyNotification("bukan json")).toThrow(/JSON/);
  });
  it("pemetaan status", () => {
    expect(midtransKind("capture", "accept")).toBe("paid");
    expect(midtransKind("capture", "challenge")).toBe("pending");
    expect(midtransKind("expire")).toBe("expired");
    expect(midtransKind("deny")).toBe("failed");
    expect(midtransKind("partial_refund")).toBe("partially_refunded");
    expect(midtransKind("aneh")).toBeNull();
  });
});

describe("Midtrans: panggilan API (fetch dipalsukan)", () => {
  it("createCharge memakai Basic auth, nominal integer, dan mengembalikan redirect_url; HTTP gagal → galat", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = new MidtransProvider({ serverKey: KEY, environment: "sandbox", fetchImpl: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ redirect_url: "https://app.sandbox.midtrans.com/snap/v4/redirection/abc" }), { status: 201 }); }) as unknown as typeof fetch });
    const now = new Date("2030-01-01T00:00:00Z");
    const r = await ok.createCharge({ orderId: "ord-1", amountIdr: 50000, expiresAt: new Date(now.getTime() + 30 * 60_000), now, customer: { name: "Tamu", email: "t@x.id" }, description: "DP", providerAccountId: "M1" });
    expect(r.checkoutUrl).toContain("midtrans.com");
    expect(calls[0]!.url).toBe("https://app.sandbox.midtrans.com/snap/v1/transactions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from(`${KEY}:`).toString("base64")}`);
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.transaction_details.gross_amount).toBe(50000);
    expect(sent.expiry.duration).toBe(30);
    const bad = new MidtransProvider({ serverKey: KEY, environment: "sandbox", fetchImpl: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch });
    await expect(bad.createCharge({ orderId: "o", amountIdr: 1, expiresAt: now, now, customer: { name: "T" }, description: "x", providerAccountId: "M1" })).rejects.toThrow(/401/);
  });
  it("refund: sukses 2xx, gagal selain itu; fetchStatus 404 → null", async () => {
    const mk = (status: number, json: unknown) => new MidtransProvider({ serverKey: KEY, environment: "sandbox", fetchImpl: (async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch });
    expect(await mk(200, { status_code: "200" }).refund({ orderId: "o", amountIdr: 1000, key: "k" })).toEqual({ ok: true });
    expect((await mk(200, { status_code: "412" }).refund({ orderId: "o", amountIdr: 1000, key: "k" })).ok).toBe(false);
    expect(await mk(404, { status_code: "404" }).fetchStatus("o")).toBeNull();
    expect(await mk(200, { transaction_status: "pending", gross_amount: "1000.00", status_code: "201" }).fetchStatus("o")).toEqual({ kind: "pending", amountIdr: 1000 });
  });
});

describe("FakeProvider", () => {
  it("notifikasi bertanda tangan terverifikasi; diubah → ditolak", () => {
    const f = new FakeProvider("rahasia-uji");
    const { body: b, headers } = f.signedNotification({ orderId: "o1", kind: "paid", amountIdr: 1000 });
    expect(f.verifyNotification(b, headers).kind).toBe("paid");
    expect(() => f.verifyNotification(b.replace("1000", "1"), headers)).toThrow(NotificationError);
    expect(() => f.verifyNotification(b, {})).toThrow(NotificationError);
  });
});
