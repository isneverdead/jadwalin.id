"use server";
import { AppError, bookPublic, cancelBookingByToken, rescheduleBookingByToken, setMeetingTypeHosts, verifyTurnstile } from "@jadwalin/core";
import { loadProxyTrust, loadTurnstileEnv } from "@jadwalin/config";
import { bookAsClient, ticketBookingHooks } from "@jadwalin/module-tickets";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPaymentDeps } from "./payments";
import { run } from "./run";
import { appBaseUrl, currentUser, getPool, requireUser } from "./server";

const str = (form: FormData, key: string) => String(form.get(key) ?? "");
const hooks = ticketBookingHooks();

/**
 * IP pemanggil untuk pembatas laju dan Turnstile. Dengan TRUST_PROXY=cloudflare (default di produksi) HANYA header
 * `cf-connecting-ip` dipercaya, dan origin harus dikunci agar hanya Cloudflare yang bisa menjangkaunya (header lain,
 * termasuk x-forwarded-for, dapat dipalsukan klien). Tanpa IP terpercaya, permintaan ditolak (tidak ada ember bersama
 * yang bisa dikuras satu penyerang). Di dev (TRUST_PROXY=none) dipakai hop pertama x-forwarded-for atau "dev-lokal".
 */
async function callerIp(): Promise<string | null> {
  const h = await headers();
  if (loadProxyTrust() === "cloudflare") return h.get("cf-connecting-ip");
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || "dev-lokal";
}

export async function bookAction(slug: string, typeSlug: string, form: FormData) {
  const back = `/${slug}/${typeSlug}`;
  // Honeypot: bot mengisi kolom tersembunyi; berpura-pura sukses tanpa melakukan apa pun.
  if (str(form, "website")) redirect(`/${slug}`);

  const ip = await callerIp();
  if (!ip) redirect(`${back}?error=${encodeURIComponent("Permintaan tidak dapat diverifikasi. Coba lagi lewat alamat resmi situs ini.")}`);
  const turnstile = loadTurnstileEnv();
  const user = await currentUser();
  // Pengguna masuk (email terverifikasi) tidak ditantang; tamu wajib lolos Turnstile bila dikonfigurasi.
  if (!user && turnstile.secret) {
    const ok = await verifyTurnstile({ secret: turnstile.secret, token: str(form, "cf-turnstile-response"), ip });
    if (!ok) redirect(`${back}?error=${encodeURIComponent("Verifikasi keamanan gagal. Muat ulang halaman dan coba lagi.")}`);
  }

  await run(back, async () => {
    const startsAt = new Date(str(form, "startsAt"));
    if (user) {
      const ticketNumber = Number(str(form, "ticket")) || undefined;
      const r = await bookAsClient(getPool(), user.id, slug, typeSlug, { startsAt, topic: str(form, "topic"), notes: str(form, "notes"), ticketNumber }, { baseUrl: appBaseUrl() });
      return `/booking/${r.manageToken}?baru=1`;
    }
    const r = await bookPublic(
      getPool(),
      slug,
      typeSlug,
      { name: str(form, "name"), email: str(form, "email"), phone: str(form, "phone"), topic: str(form, "topic"), notes: str(form, "notes"), startsAt, privacyAck: form.get("privacy") === "on" },
      { baseUrl: appBaseUrl(), clientIdentity: ip, hooks, payments: getPaymentDeps() },
    );
    // Booking berDP: lanjut ke halaman bayar penyedia; halaman kelola menampilkan statusnya bila tamu kembali.
    return r.payment ? r.payment.checkoutUrl : `/booking/${r.manageToken}?baru=1`;
  });
}

export async function cancelBookingAction(token: string) {
  await run(`/booking/${token}`, async () => {
    await cancelBookingByToken(getPool(), token, { baseUrl: appBaseUrl(), hooks });
  });
}

export async function rescheduleBookingAction(token: string, form: FormData) {
  await run(`/booking/${token}/ubah`, async () => {
    const startsAt = new Date(str(form, "startsAt"));
    if (Number.isNaN(startsAt.getTime())) throw new AppError("invalid_input", "Pilih waktu terlebih dulu.");
    await rescheduleBookingByToken(getPool(), token, startsAt, { baseUrl: appBaseUrl(), hooks });
    return `/booking/${token}?diubah=1`;
  });
}

export async function setHostsAction(slug: string, meetingTypeId: string, form: FormData) {
  const user = await requireUser();
  await run(`/w/${slug}/jadwal`, async () => {
    await setMeetingTypeHosts(getPool(), { userId: user.id, slug }, meetingTypeId, form.getAll("host").map(String));
  });
}
