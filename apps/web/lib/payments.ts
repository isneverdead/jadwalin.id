import { loadPaymentEnv } from "@jadwalin/config";
import { bookingPaymentHooks, createPaymentProvider, type PaymentDeps } from "@jadwalin/core";
import { ticketBookingHooks } from "@jadwalin/module-tickets";
import { appBaseUrl, getPool } from "./server";

/** Layanan pembayaran aplikasi web; null bila PAYMENT_PROVIDER tidak diatur (jenis berDP ditolak, gagal tertutup). */
export function getPaymentDeps(): PaymentDeps | undefined {
  const cfg = loadPaymentEnv();
  if (!cfg) return undefined;
  return { pool: getPool(), provider: createPaymentProvider(cfg), hooks: bookingPaymentHooks({ baseUrl: appBaseUrl(), hooks: ticketBookingHooks() }) };
}
