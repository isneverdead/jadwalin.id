/**
 * Pelaporan galat server ke Sentry TANPA data pribadi (lihat packages/core/src/observability.ts). Tanpa SENTRY_DSN mati.
 * Rute dilaporkan sebagai pola (`/booking/[token]`), bukan URL sebenarnya, agar token tidak keluar.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    (await import("./instrumentation-node")).registerNode();
  }
}

export async function onRequestError(error: unknown, _request: unknown, context: { routePath?: string; routeType?: string }) {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    (await import("./instrumentation-node")).reportRequestError(error, context);
  }
}
