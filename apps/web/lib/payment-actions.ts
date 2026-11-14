"use server";
import {
  AppError, deletePaymentMethod, requestProofUpload, reviewPayment, savePaymentMethod, setPaymentMethodActive, submitProof, type PaymentMethodKind,
} from "@jadwalin/core";
import { getPaymentDeps } from "./payments";
import { run } from "./run";
import { appBaseUrl, getPool, getStorage, requireUser } from "./server";

const str = (f: FormData, k: string) => String(f.get(k) ?? "");
const KINDS = ["bank_transfer", "qris", "ewallet", "other"] as const;

export async function saveMethodAction(slug: string, form: FormData) {
  const user = await requireUser();
  const kind = str(form, "kind");
  await run(`/w/${slug}/pembayaran`, async () => {
    await savePaymentMethod(getPool(), { userId: user.id, slug }, {
      kind: (KINDS as readonly string[]).includes(kind) ? (kind as PaymentMethodKind) : "other",
      label: str(form, "label"),
      accountName: str(form, "accountName"),
      accountNumber: str(form, "accountNumber"),
      instructions: str(form, "instructions"),
      qrisFileId: str(form, "qrisFileId") || null,
    });
  });
}

export async function toggleMethodAction(slug: string, id: string, active: boolean) {
  const user = await requireUser();
  await run(`/w/${slug}/pembayaran`, async () => {
    await setPaymentMethodActive(getPool(), { userId: user.id, slug }, id, active);
  });
}

export async function deleteMethodAction(slug: string, id: string) {
  const user = await requireUser();
  await run(`/w/${slug}/pembayaran`, async () => {
    await deletePaymentMethod(getPool(), { userId: user.id, slug }, id);
  });
}

export async function reviewPaymentAction(slug: string, paymentId: string, form: FormData) {
  const user = await requireUser();
  const accept = str(form, "decision") === "accept";
  await run(`/w/${slug}/pembayaran`, async () => {
    const r = await reviewPayment(getPaymentDeps(), { userId: user.id, slug }, paymentId, accept ? { accept: true } : { accept: false, reason: str(form, "reason") });
    if (r.lateBooking) throw new AppError("invalid_input", "Pembayaran dicatat lunas, tetapi booking-nya sudah dibatalkan/dilepas. Kembalikan dana ke pelanggan dan catat refund.");
  });
}

// --- Pelanggan (tamu) lewat token booking: tanpa login; token adalah kredensialnya ---------------------

export type ProofTicket = { ok: true; fileId: string; url: string; headers: Record<string, string> } | { ok: false; error: string };

export async function requestProofAction(token: string, input: { filename: string; mime: string; sizeBytes: number }): Promise<ProofTicket> {
  try {
    const { fileId, upload } = await requestProofUpload(getPool(), getStorage(), token, input);
    return { ok: true, fileId, url: upload.url, headers: upload.headers };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function submitProofAction(token: string, fileId: string, note: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await submitProof(getPool(), getStorage(), token, fileId, note, { baseUrl: appBaseUrl() });
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}
