import { loadProxyTrust, loadStorageEnv, loadSuperadmins, loadWebEnv } from "@jadwalin/config";
import { createAuth, isSuperadmin, isUserSuspended, listMyWorkspaces, S3Storage, type Auth } from "@jadwalin/core";
import { createPool } from "@jadwalin/db";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type pg from "pg";
import { cache } from "react";

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

/** Sesi dibaca sekali per permintaan (layout dan halaman berbagi hasilnya lewat cache React). */
const getRawSession = cache(async () => getAuth().api.getSession({ headers: await headers() }));
const getSession = cache(async () => {
  const session = await getRawSession();
  // Akun yang ditangguhkan superadmin (ADR 0005): sesinya dianggap tidak ada.
  if (session && (await isUserSuspended(getPool(), session.user.id).catch(() => false))) return null;
  return session;
});

export async function requireUser() {
  const session = await getSession();
  if (!session) {
    // Beri tahu akun yang ditangguhkan, bukan sekadar memantulkan ke halaman masuk.
    if (await getRawSession()) redirect(`/masuk?error=${encodeURIComponent("Akun Anda ditangguhkan. Hubungi admin jadwalin.id.")}`);
    redirect("/masuk");
  }
  return session.user;
}

/** Email superadmin platform dari env (SUPERADMIN_EMAILS). */
export const superadminEmails = () => loadSuperadmins();

/** Apakah pengguna ini superadmin (untuk menampilkan tautan Admin saja; otorisasi tetap di core). */
export const userIsSuperadmin = cache(async (userId: string) => isSuperadmin(getPool(), userId, superadminEmails()));

/** Halaman /admin: selain superadmin mendapat 404 (keberadaan halaman tidak dibuka). */
export async function requireSuperadmin() {
  const session = await getSession();
  if (!session || !(await userIsSuperadmin(session.user.id))) notFound();
  return session.user;
}

/** Daftar halaman jadwal milik pengguna, sekali per permintaan (layout + halaman). */
export const myWorkspaces = cache(async (userId: string) => listMyWorkspaces(getPool(), userId));

export async function currentUser() {
  const session = await getSession();
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
