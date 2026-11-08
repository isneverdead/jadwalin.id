import { NotificationError, processWebhook } from "@jadwalin/core";
import { getPaymentDeps } from "@/lib/payments";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Notifikasi penyedia pembayaran. Tanda tangan diverifikasi sebelum apa pun disimpan; pemrosesan idempoten (webhook_inbox).
 * 400 untuk notifikasi tidak sah (penyedia tidak perlu mencoba ulang); 500 untuk galat sementara (penyedia mencoba ulang).
 */
export async function POST(request: Request) {
  const deps = getPaymentDeps();
  if (!deps) return new Response("Pembayaran tidak aktif", { status: 404 });
  const raw = await request.text();
  if (raw.length > 100_000) return new Response("Terlalu besar", { status: 413 });
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  try {
    const result = await processWebhook(deps, raw, headers);
    if (result === "rejected") logger.warn({ provider: deps.provider.name }, "webhook pembayaran ditolak (nominal tidak cocok)");
    return Response.json({ ok: true, result });
  } catch (error) {
    if (error instanceof NotificationError) return new Response("Notifikasi tidak valid", { status: 400 });
    logger.error({ err: error instanceof Error ? error.message : String(error) }, "webhook pembayaran gagal");
    return new Response("Galat sementara", { status: 500 });
  }
}
