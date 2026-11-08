export type ErrorCode =
  | "not_found"
  | "forbidden"
  | "slug_taken"
  | "invalid_slug"
  | "user_not_found"
  | "already_member"
  | "rate_limited"
  | "invitation_exists"
  | "invitation_invalid"
  | "slot_unavailable"
  | "invalid_input"
  | "payment_unavailable"
  | "payment_failed";

/** Error yang aman ditampilkan ke pengguna (pesan Bahasa Indonesia). */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Kode unik-violation Postgres, termasuk yang dibungkus Drizzle (`cause`). */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string; cause?: unknown } | null;
  if (!e) return false;
  if (e.code === "23505") return !constraint || e.constraint === constraint;
  return e.cause ? isUniqueViolation(e.cause, constraint) : false;
}

/** exclusion_violation (23P01): constraint anti-bentrok jadwal menolak insert. */
export function isExclusionViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string; cause?: unknown } | null;
  if (!e) return false;
  if (e.code === "23P01") return !constraint || e.constraint === constraint;
  return e.cause ? isExclusionViolation(e.cause, constraint) : false;
}
