import { AppError, initObservability, reportError } from "@jadwalin/core";

/** Khusus runtime Node (dipisah dari instrumentation.ts agar tak ikut terbundel ke Edge). */
export function registerNode(): void {
  initObservability({ dsn: process.env.SENTRY_DSN, environment: process.env.SENTRY_ENVIRONMENT, release: process.env.SENTRY_RELEASE, service: "web" });
}

export function reportRequestError(error: unknown, context: { routePath?: string; routeType?: string }): void {
  if (error instanceof AppError) return; // galat yang memang ditujukan ke pengguna, bukan bug
  reportError(error, { where: `${context.routeType ?? "route"}:${context.routePath ?? "?"}` });
}
