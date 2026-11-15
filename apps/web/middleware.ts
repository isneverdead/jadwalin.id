import { NextResponse, type NextRequest } from "next/server";

/**
 * Header keamanan + CSP ber-nonce per permintaan. Nonce menggantikan 'unsafe-inline' untuk skrip; halaman wajib dirender
 * dinamis (lihat `dynamic = "force-dynamic"` di app/layout.tsx) supaya Next dapat memberi nonce pada skrip hidrasi.
 */
function origins(...urls: (string | undefined)[]): string[] {
  return urls.flatMap((u) => {
    try {
      return u ? [new URL(u).origin] : [];
    } catch {
      return [];
    }
  });
}

// Halaman yang URL-nya memuat token rahasia: jangan bocor lewat Referer, jangan di-cache.
const TOKEN_PATHS = [/^\/booking\//, /^\/undangan\//, /^\/reset-sandi/, /^\/api\/auth\/(verify-email|reset-password)/];

export function middleware(request: NextRequest) {
  const isProd = process.env.NODE_ENV === "production";
  const nonce = btoa(crypto.randomUUID());
  // Dev: HMR Next memakai WebSocket.
  const connect = ["'self'", ...(isProd ? [] : ["ws:", "wss:"]), ...origins(process.env.S3_ENDPOINT, process.env.SENTRY_DSN?.replace(/^(https?:\/\/)[^@]*@/, "$1"), "https://challenges.cloudflare.com")];

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://challenges.cloudflare.com${isProd ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${origins(process.env.S3_ENDPOINT).join(" ")}`.trim(),
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "frame-src https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Hanya bila situs memang HTTPS: di build produksi lokal (E2E) memaksa HTTPS akan memblokir penyimpanan http://localhost.
    ...(isProd && process.env.BETTER_AUTH_URL?.startsWith("https://") ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("x-pathname", request.nextUrl.pathname);
  headers.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.headers.set("Referrer-Policy", TOKEN_PATHS.some((p) => p.test(request.nextUrl.pathname)) ? "no-referrer" : "strict-origin-when-cross-origin");
  if (TOKEN_PATHS.some((p) => p.test(request.nextUrl.pathname))) response.headers.set("Cache-Control", "no-store");
  if (isProd) response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] }],
};
