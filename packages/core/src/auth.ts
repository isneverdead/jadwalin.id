import { schema, withWorker } from "@jadwalin/db";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { AppError } from "./errors";
import { enqueueSystemEmail } from "./notifications";
import { consumeRateLimit, rateKey } from "./rate-limit";
import { LEGAL_VERSION } from "./legal";
import { normalizePhone } from "./phone";

/** Jejak keamanan tingkat platform (tanpa workspace, tanpa data pribadi mentah: email di-hash). */
export async function recordAuthEvent(pool: pg.Pool, e: { action: string; entityId: string; diff?: Record<string, unknown> }): Promise<void> {
  try {
    await withWorker(pool, (db) => db.insert(schema.auditLog).values({ workspaceId: null, actorUserId: null, action: e.action, entityType: "auth", entityId: e.entityId, diff: e.diff ?? null }));
  } catch {
    // Gagal mencatat jejak tidak boleh menggagalkan masuk/daftar.
  }
}

export interface AuthOptions {
  pool: pg.Pool;
  secret: string;
  baseURL: string;
  plugins?: BetterAuthPlugin[];
  /** Header IP yang dipercaya untuk pembatas laju (mis. ["cf-connecting-ip"] di belakang Cloudflare). */
  ipAddressHeaders?: string[];
  /** Pendaftaran akun baru ditutup (SIGNUP_CLOSED=true). */
  signupClosed?: boolean;
}

/** Auth platform: email + kata sandi, sesi di DB sendiri, rate limit tersimpan di DB. */
export function createAuth({ pool, secret, baseURL, plugins, ipAddressHeaders, signupClosed }: AuthOptions) {
  const db = drizzle(pool, { schema });
  const allowedOrigin = new URL(baseURL).origin;
  return betterAuth({
    secret,
    baseURL,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        rateLimit: schema.rateLimits,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      // Email harus terbukti milik pendaftar sebelum bisa masuk (juga syarat menerima undangan workspace).
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await enqueueSystemEmail(pool, { to: user.email, template: "reset_password", payload: { name: user.name, url } });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) => {
        await enqueueSystemEmail(pool, { to: user.email, template: "verify_email", payload: { name: user.name, url } });
      },
    },
    user: {
      additionalFields: {
        phone: { type: "string", required: false },
        locale: { type: "string", required: false, defaultValue: "id-ID" },
      },
    },
    databaseHooks: {
      user: {
        // Nomor HP dinormalisasi juga saat profil diubah (aturan #6); tanpa ini nilai mentah bisa lolos lewat update-user.
        update: {
          before: async (user, hookCtx) => {
            const phone = (user as { phone?: string | null }).phone;
            if (phone === undefined || phone === null || phone === "") return { data: user };
            let normalized: string;
            try {
              normalized = normalizePhone(phone);
            } catch {
              throw new APIError("BAD_REQUEST", { message: "Nomor HP tidak valid." });
            }
            // Nomor unik: beri pesan yang jelas alih-alih galat basis data mentah.
            const selfId = (hookCtx as { context?: { session?: { user?: { id?: string } } } } | null)?.context?.session?.user?.id;
            const taken = await pool.query(`SELECT 1 FROM users WHERE phone = $1 AND id IS DISTINCT FROM $2::uuid LIMIT 1`, [normalized, selfId ?? null]);
            if ((taken.rowCount ?? 0) > 0) throw new APIError("BAD_REQUEST", { message: "Nomor HP ini tidak dapat digunakan." });
            return { data: { ...user, phone: normalized } };
          },
        },
        create: {
          before: async (user) => {
            const phone = (user as { phone?: string | null }).phone;
            return { data: { ...user, phone: phone ? normalizePhone(phone) : null } };
          },
        },
      },
    },
    advanced: { database: { generateId: "uuid" }, ...(ipAddressHeaders ? { ipAddress: { ipAddressHeaders } } : {}) },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 3600, max: 10 },
        "/request-password-reset": { window: 3600, max: 5 },
        "/forget-password": { window: 3600, max: 5 },
        "/send-verification-email": { window: 3600, max: 5 },
        "/reset-password": { window: 600, max: 10 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const req = ctx.request;
        // Semua permintaan tulis dari browser wajib berasal dari origin aplikasi (tutup login-CSRF; pengecekan bawaan
        // hanya berlaku bila ada cookie). Pemanggilan server-ke-server lewat auth.api tidak punya request dan dilewati.
        if (req && req.method !== "GET" && req.method !== "HEAD" && req.headers.get("origin") !== allowedOrigin) {
          throw new APIError("FORBIDDEN", { message: "Origin tidak diizinkan." });
        }
        if (signupClosed && ctx.path === "/sign-up/email") {
          throw new APIError("FORBIDDEN", { message: "Pendaftaran sedang ditutup." });
        }
        // Pendaftaran dari browser wajib menyatakan persetujuan Syarat & Privasi (pemanggilan server-ke-server dilewati).
        if (req && ctx.path === "/sign-up/email" && (ctx.body as { termsAccepted?: unknown } | undefined)?.termsAccepted !== true) {
          throw new APIError("BAD_REQUEST", { message: "Anda perlu menyetujui Syarat Layanan dan Kebijakan Privasi." });
        }
        if (ctx.path === "/sign-in/email") {
          // Per email, selain per IP: membatasi tebak kata sandi terdistribusi ke satu akun.
          const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "").trim().toLowerCase();
          if (email) {
            try {
              await consumeRateLimit(pool, rateKey("login-email", email), { limit: 10, windowSec: 900 });
            } catch (error) {
              if (error instanceof AppError && error.code === "rate_limited") throw new APIError("TOO_MANY_REQUESTS", { message: "Terlalu banyak percobaan masuk untuk akun ini. Coba lagi dalam 15 menit." });
              throw error;
            }
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        const failed = isAPIError(returned);
        const body = (ctx.body ?? {}) as { email?: unknown };
        const emailKey = typeof body.email === "string" ? `email:${rateKey("a", body.email).slice(2)}` : "email:-";
        if (ctx.path === "/sign-in/email") {
          const userId = ctx.context.newSession?.user.id;
          if (!failed && userId) await recordAuthEvent(pool, { action: "auth.sign_in", entityId: userId });
          else if (failed) await recordAuthEvent(pool, { action: "auth.sign_in_failed", entityId: emailKey, diff: { status: (returned as { status?: unknown }).status ?? null } });
        } else if (ctx.path === "/sign-up/email" && !failed) {
          await recordAuthEvent(pool, { action: "auth.sign_up", entityId: emailKey });
          // Bukti persetujuan: versi dokumen diisi SERVER setelah akun terbentuk (formulir sudah dipastikan menyatakan setuju).
          const body = ctx.body as { email?: unknown; termsAccepted?: unknown } | undefined;
          if (body?.termsAccepted === true && typeof body.email === "string") {
            await pool.query(`UPDATE users SET terms_version = $1, terms_accepted_at = now() WHERE lower(email) = lower($2) AND terms_version IS NULL`, [LEGAL_VERSION, body.email.trim()]);
          }
        } else if (ctx.path === "/reset-password") {
          await recordAuthEvent(pool, { action: failed ? "auth.password_reset_failed" : "auth.password_reset", entityId: "-" });
        } else if (ctx.path === "/sign-out" && !failed) {
          await recordAuthEvent(pool, { action: "auth.sign_out", entityId: "-" });
        }
      }),
    },
    plugins,
  });
}

export type Auth = ReturnType<typeof createAuth>;
