import { loadPaymentEnv } from "@jadwalin/config";
import { bookingPaymentHooks, createPaymentProvider, type PaymentDeps } from "@jadwalin/core";
import { ticketBookingHooks } from "@jadwalin/module-tickets";
import { appBaseUrl, getPool } from "./server";

/** Layanan pembayaran aplikasi web. Bawaan: manual (ADR 0002). */
export function getPaymentDeps(): PaymentDeps {
  const cfg = loadPaymentEnv();
  return { pool: getPool(), provider: createPaymentProvider(cfg), hooks: bookingPaymentHooks({ baseUrl: appBaseUrl(), hooks: ticketBookingHooks() }) };
}
