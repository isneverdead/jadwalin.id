import { loadProxyTrust, loadStorageEnv, loadWebEnv } from "@jadwalin/config";
import { createAuth, S3Storage, type Auth } from "@jadwalin/core";
import { createPool } from "@jadwalin/db";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type pg from "pg";

// Cache di globalThis agar tidak membuat pool baru tiap hot reload.
const g = globalThis as unknown as { __pool?: pg.Pool; __auth?: Auth; __storage?: S3Storage };

export function getPool(): pg.Pool {
  return (g.__pool ??= createPool(loadWebEnv().DATABASE_URL));
}

export function getAuth(): Auth {
  if (!g.__auth) {
    const env = loadWebEnv();
    g.__auth = createAuth({ pool: getPool(), secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL, plugins: [nextCookies()], ipAddressHeaders: loadProxyTrust() === "cloudflare" ? ["cf-connecting-ip"] : undefined });
  }
  return g.__auth;
}

export async function requireUser() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/masuk");
  return session.user;
}

export async function currentUser() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  return session?.user ?? null;
}

export function getStorage(): S3Storage {
  if (!g.__storage) {
    const s = loadStorageEnv();
    g.__storage = new S3Storage({ endpoint: s.S3_ENDPOINT, region: s.S3_REGION, bucket: s.S3_BUCKET, accessKeyId: s.S3_ACCESS_KEY_ID, secretAccessKey: s.S3_SECRET_ACCESS_KEY, forcePathStyle: s.S3_FORCE_PATH_STYLE === "true" });
  }
  return g.__storage;
}

export function appBaseUrl(): string {
  return loadWebEnv().BETTER_AUTH_URL;
}

/** Tujuan setelah masuk: hanya path internal (cegah open redirect). */
export function safeNext(next: string | undefined | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/dashboard";
}
