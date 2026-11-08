import * as Sentry from "@sentry/node";
import type { ErrorEvent, EventHint } from "@sentry/node";

/** Bentuk minimal transport Sentry (untuk tes). */
export interface SentryTransport {
  send(envelope: unknown): Promise<unknown>;
  flush(timeout?: number): Promise<boolean>;
}

/**
 * Pelaporan galat TANPA data pribadi (UU PDP). Sentry hanya menerima: jenis galat, tumpukan pemanggilan, dan rute.
 * Yang dibersihkan sebelum keluar dari server kita:
 *  - token rahasia di URL (booking, undangan, reset sandi, verifikasi) dan seluruh query string
 *  - alamat email dan nomor telepon di teks galat
 *  - parameter query SQL ("params: ...") yang ikut tercetak pada galat Drizzle/pg (memuat email, token, hash)
 *  - cookie, Authorization, dan isi permintaan
 */
const TOKEN_PATH = /(\/(?:booking|undangan|reset-sandi|reset-password|verify-email)\/)[A-Za-z0-9_.~%-]{8,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w.])(?:\+?62|0)8\d{7,12}(?!\w|\.\d)/g;
const LONG_TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;

export function scrubString(input: string): string {
  let s = input;
  // Galat pg/Drizzle: "Failed query: ... \nparams: a,b,c" — buang parameter terikat.
  s = s.replace(/(\bparams:)[\s\S]*$/i, "$1 [dibuang]");
  s = s.replace(TOKEN_PATH, "$1[token]");
  s = s.replace(/([?&](?:token|code|key|secret)=)[^&\s"']+/gi, "$1[token]");
  s = s.replace(EMAIL, "[email]");
  s = s.replace(PHONE, "[telepon]");
  s = s.replace(LONG_TOKEN, "[token]");
  return s;
}

function scrubUrl(url: string): string {
  const noQuery = url.split(/[?#]/)[0] ?? url;
  return scrubString(noQuery);
}

export function scrubEvent<T extends ErrorEvent>(event: T): T {
  if (event.message) event.message = scrubString(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubString(ex.value);
    for (const f of ex.stacktrace?.frames ?? []) {
      // Berkas dan nomor baris cukup untuk menelusuri bug; nilai variabel lokal dan potongan kode sumber tidak dikirim.
      const frame = f as { vars?: unknown; pre_context?: unknown; context_line?: unknown; post_context?: unknown };
      delete frame.vars;
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
    }
  }
  if (event.transaction) event.transaction = scrubUrl(event.transaction);
  if (event.request) {
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    event.request.headers = Object.fromEntries(Object.entries(event.request.headers ?? {}).filter(([k]) => /^(user-agent|accept|content-type)$/i.test(k)));
  }
  delete event.user;
  for (const b of event.breadcrumbs ?? []) {
    if (b.message) b.message = scrubString(b.message);
    if (b.data) {
      for (const [k, v] of Object.entries(b.data)) b.data[k] = typeof v === "string" ? scrubString(v) : v;
      if (typeof b.data.url === "string") b.data.url = scrubUrl(b.data.url);
    }
  }
  if (event.extra) for (const [k, v] of Object.entries(event.extra)) if (typeof v === "string") event.extra[k] = scrubString(v);
  return event;
}

export interface ObservabilityOptions {
  dsn?: string | null;
  environment?: string;
  release?: string;
  service: "web" | "worker";
  /** Hanya untuk tes: tampung envelope alih-alih mengirim ke jaringan. */
  transport?: (options: unknown) => SentryTransport;
}

let enabled = false;

/** Tanpa DSN, pelaporan MATI (tidak ada yang keluar dari server). */
export function initObservability(opts: ObservabilityOptions): boolean {
  if (!opts.dsn) return false;
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment ?? process.env.NODE_ENV ?? "development",
    release: opts.release,
    sendDefaultPii: false,
    tracesSampleRate: 0, // hanya galat; tanpa pelacakan performa (mengurangi data yang keluar)
    includeLocalVariables: false,
    beforeSend: (event: ErrorEvent, _hint: EventHint) => scrubEvent(event),
    initialScope: { tags: { service: opts.service } },
    ...(opts.transport ? { transport: opts.transport as never } : {}),
  });
  enabled = true;
  return true;
}

/** Laporkan galat tak terduga. Galat yang memang ditujukan ke pengguna (AppError) bukan bug dan tak dilaporkan. */
export function reportError(error: unknown, context: { where: string } & Record<string, string | number | boolean>): void {
  if (!enabled) return;
  const { where, ...tags } = context;
  Sentry.withScope((scope) => {
    scope.setTag("where", where);
    for (const [k, v] of Object.entries(tags)) scope.setTag(k, String(v));
    Sentry.captureException(error);
  });
}

export async function flushObservability(timeoutMs = 2000): Promise<void> {
  if (enabled) await Sentry.flush(timeoutMs);
}
