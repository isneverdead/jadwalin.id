"use server";
import { AppError, verifyTurnstile, type ReservationStatus } from "@jadwalin/core";
import { loadProxyTrust, loadTurnstileEnv } from "@jadwalin/config";
import { cancelRentalByToken, createProduct, requestProductImageUpload, requestRental, setOrderStatus, setProductActive, updateProduct } from "@jadwalin/module-rental";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { run } from "./run";
import { appBaseUrl, getPool, getStorage, requireUser } from "./server";

const str = (form: FormData, key: string) => String(form.get(key) ?? "");
const int = (form: FormData, key: string, fallback = 0) => {
  const v = str(form, key).replace(/[^\d]/g, "");
  return v === "" ? fallback : Number(v);
};

async function callerIp(): Promise<string | null> {
  const h = await headers();
  if (loadProxyTrust() === "cloudflare") return h.get("cf-connecting-ip");
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || "dev-lokal";
}

export type ImageTicket = { ok: true; fileId: string; url: string; headers: Record<string, string> } | { ok: false; error: string };

/** Foto produk: URL unggah langsung ke penyimpanan (jalur sendiri; tidak bergantung pada fitur Berkas). */
export async function requestProductImageAction(slug: string, input: { filename: string; mime: string; sizeBytes: number }): Promise<ImageTicket> {
  const user = await requireUser();
  try {
    const { fileId, upload } = await requestProductImageUpload(getPool(), { userId: user.id, slug }, getStorage(), input);
    return { ok: true, fileId, url: upload.url, headers: upload.headers };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveProductAction(slug: string, productId: string | null, form: FormData) {
  const user = await requireUser();
  await run(`/w/${slug}/produk`, async () => {
    const input = {
      name: str(form, "name"),
      category: str(form, "category"),
      description: str(form, "description"),
      pricePerDayIdr: int(form, "pricePerDayIdr"),
      depositIdr: int(form, "depositIdr"),
      dpPercent: Math.min(100, int(form, "dpPercent")),
      units: int(form, "units", 1),
      imageFileId: str(form, "imageFileId") || null,
    };
    const actor = { userId: user.id, slug };
    if (productId) await updateProduct(getPool(), actor, productId, input);
    else await createProduct(getPool(), actor, input);
    return `/w/${slug}/produk?tersimpan=1`;
  });
}

export async function toggleProductAction(slug: string, productId: string, active: boolean) {
  const user = await requireUser();
  await run(`/w/${slug}/produk`, async () => {
    await setProductActive(getPool(), { userId: user.id, slug }, productId, active);
  });
}

const STATUSES = new Set(["confirmed", "rejected", "active", "completed", "cancelled"]);
export async function setOrderStatusAction(slug: string, orderId: string, to: string) {
  const user = await requireUser();
  await run(`/w/${slug}/sewa`, async () => {
    if (!STATUSES.has(to)) throw new AppError("invalid_input", "Status tidak valid.");
    await setOrderStatus(getPool(), { userId: user.id, slug }, orderId, to as ReservationStatus, { baseUrl: appBaseUrl() });
  });
}

/** Tamu mengajukan sewa: honeypot + Turnstile + pembatas laju DB (aturan proyek untuk endpoint tulis publik). */
export async function requestRentalAction(slug: string, productId: string, form: FormData) {
  const back = `/${slug}/produk/${productId}`;
  if (str(form, "website")) redirect(`/${slug}`);
  const ip = await callerIp();
  if (!ip) redirect(`${back}?error=${encodeURIComponent("Permintaan tidak dapat diverifikasi. Coba lagi lewat alamat resmi situs ini.")}`);
  const turnstile = loadTurnstileEnv();
  if (turnstile.secret) {
    const ok = await verifyTurnstile({ secret: turnstile.secret, token: str(form, "cf-turnstile-response"), ip });
    if (!ok) redirect(`${back}?error=${encodeURIComponent("Verifikasi keamanan gagal. Muat ulang halaman dan coba lagi.")}`);
  }
  await run(back, async () => {
    const r = await requestRental(
      getPool(), slug, productId,
      { name: str(form, "name"), phone: str(form, "phone"), startDate: str(form, "startDate"), endDate: str(form, "endDate"), note: str(form, "note"), privacyAck: form.get("privacy") === "on" },
      { baseUrl: appBaseUrl(), clientIdentity: ip },
    );
    return `/sewa/${r.token}?baru=1`;
  });
}

export async function cancelRentalAction(token: string) {
  await run(`/sewa/${token}`, async () => {
    await cancelRentalByToken(getPool(), token, { baseUrl: appBaseUrl() });
  });
}
