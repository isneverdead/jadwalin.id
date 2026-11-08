import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PAYMENT_STATUSES, assertTransition, canTransition, isTerminal, nextStatus, type ProviderEventKind } from "./payment-state";

const EVENTS: ProviderEventKind[] = ["pending", "paid", "expired", "failed", "cancelled", "refunded", "partially_refunded"];

describe("state machine pembayaran", () => {
  it("jalur normal: created → pending → paid → refunded", () => {
    expect(nextStatus("created", "pending")).toBe("pending");
    expect(nextStatus("pending", "paid")).toBe("paid");
    expect(nextStatus("paid", "refunded")).toBe("refunded");
  });

  it("duplikat diabaikan (idempoten)", () => {
    for (const s of PAYMENT_STATUSES) for (const e of EVENTS) if (s === e) expect(nextStatus(s, e)).toBeNull();
  });

  it("status terminal tidak pernah berubah, apa pun kejadiannya", () => {
    for (const s of PAYMENT_STATUSES.filter(isTerminal)) for (const e of EVENTS) expect(nextStatus(s, e)).toBeNull();
  });

  it("notifikasi TERLAMBAT: 'pending' setelah 'paid' tidak memundurkan status", () => {
    expect(nextStatus("paid", "pending")).toBeNull();
    expect(nextStatus("paid", "expired")).toBeNull();
    expect(nextStatus("refunded", "paid")).toBeNull();
  });

  it("bayar setelah kedaluwarsa tetap diakui (dana nyata diterima penyedia)", () => {
    expect(nextStatus("expired", "paid")).toBe("paid");
    expect(nextStatus("failed", "paid")).toBeNull();
    expect(nextStatus("cancelled", "paid")).toBeNull();
  });

  it("assertTransition melempar untuk transisi tak sah", () => {
    expect(() => assertTransition("paid", "pending")).toThrow(/tidak sah/);
    expect(() => assertTransition("pending", "paid")).not.toThrow();
  });

  it("properti: urutan kejadian acak tak pernah menghasilkan transisi tak sah dan tak pernah keluar dari terminal", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...EVENTS), { maxLength: 40 }), (events) => {
        let s: (typeof PAYMENT_STATUSES)[number] = "created";
        for (const e of events) {
          const to = nextStatus(s, e);
          if (to) {
            expect(canTransition(s, to)).toBe(true);
            s = to;
          }
          if (isTerminal(s)) {
            for (const e2 of EVENTS) expect(nextStatus(s, e2)).toBeNull();
          }
        }
      }),
    );
  });
});
