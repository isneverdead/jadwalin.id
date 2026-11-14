"use server";
import {
  AppError, acknowledgeRefund, completeRefund, decideBookingRequest, setContactPhone, requestCancellation, requestRefundProofUpload, requestReschedule, setChangeSettings, withdrawRequest,
} from "@jadwalin/core";
import { ticketBookingHooks } from "@jadwalin/module-tickets";
import { run } from "./run";
import { appBaseUrl, getPool, getStorage, requireUser } from "./server";

const str = (f: FormData, k: string) => String(f.get(k) ?? "");
const hooks = ticketBookingHooks();

// --- Pelanggan (lewat token booking) -----------------------------------------------------------------

export async function requestCancelAction(token: string, form: FormData) {
  await run(`/booking/${token}`, async () => {
    await requestCancellation(getPool(), token, { reason: str(form, "reason"), refundAccount: str(form, "refundAccount") }, { baseUrl: appBaseUrl() });
    return `/booking/${token}?diajukan=1`;
  });
}

export async function requestRescheduleAction(token: string, form: FormData) {
  await run(`/booking/${token}/ubah`, async () => {
    const startsAt = new Date(str(form, "startsAt"));
    await requestReschedule(getPool(), token, startsAt, { note: str(form, "note") }, { baseUrl: appBaseUrl() });
    return `/booking/${token}?diajukan=1`;
  });
}

export async function withdrawRequestAction(token: string) {
  await run(`/booking/${token}`, async () => {
    await withdrawRequest(getPool(), token);
  });
}

export async function ackRefundAction(token: string, ack: "received" | "not_received") {
  await run(`/booking/${token}`, async () => {
    await acknowledgeRefund(getPool(), token, ack, { baseUrl: appBaseUrl() });
  });
}

// --- Penyedia jasa -------------------------------------------------------------------------------------

export async function decideRequestAction(slug: string, requestId: string, form: FormData) {
  const user = await requireUser();
  const approve = str(form, "decision") === "approve";
  await run(`/w/${slug}/perubahan`, async () => {
    const amount = str(form, "refund").replace(/\D/g, "");
    await decideBookingRequest(getPool(), { userId: user.id, slug }, requestId, approve ? { approve: true, refundAmountIdr: amount === "" ? undefined : Number(amount), note: str(form, "note") } : { approve: false, note: str(form, "note") }, { baseUrl: appBaseUrl(), hooks });
  });
}

export type RefundProofTicket = { ok: true; url: string; headers: Record<string, string> } | { ok: false; error: string };

export async function requestRefundProofAction(slug: string, requestId: string, input: { filename: string; mime: string; sizeBytes: number }): Promise<RefundProofTicket> {
  const user = await requireUser();
  try {
    const { upload } = await requestRefundProofUpload(getPool(), { userId: user.id, slug }, getStorage(), requestId, input);
    return { ok: true, url: upload.url, headers: upload.headers };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function completeRefundAction(slug: string, requestId: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  try {
    await completeRefund(getPool(), { userId: user.id, slug }, getStorage(), requestId, { baseUrl: appBaseUrl(), hooks });
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveChangeSettingsAction(slug: string, form: FormData) {
  const user = await requireUser();
  await run(`/w/${slug}/pengaturan`, async () => {
    await setChangeSettings(getPool(), { userId: user.id, slug }, { rescheduleMode: str(form, "rescheduleMode") === "approval" ? "approval" : "auto", changeMinHours: Number(str(form, "changeMinHours") || 0) });
    return `/w/${slug}/pengaturan?ok=perubahan`;
  });
}

/** Penyedia memilih nomor WhatsApp yang tampil di halaman booking pelanggan: anggota tim (nomor profil), nomor lain, atau tidak ada. */
export async function saveContactPhoneAction(slug: string, form: FormData) {
  const user = await requireUser();
  const pick = str(form, "pick");
  const phone = pick === "custom" ? str(form, "custom") : pick;
  await run(`/w/${slug}/pengaturan`, async () => {
    await setContactPhone(getPool(), { userId: user.id, slug }, phone);
    return `/w/${slug}/pengaturan?ok=kontak`;
  });
}
