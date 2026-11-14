"use server";
import { AppError, cancelUpgradeInvoice, createUpgradeInvoice, requestPlanProofUpload, submitPlanProof } from "@jadwalin/core";
import { run } from "./run";
import { getPool, getStorage, requireUser } from "./server";

const str = (f: FormData, k: string) => String(f.get(k) ?? "");

/** Pemilik membuat tagihan upgrade paket (nominal dari daftar harga di core). */
export async function createInvoiceAction(slug: string, form: FormData) {
  const user = await requireUser();
  await run(`/w/${slug}/paket`, async () => {
    await createUpgradeInvoice(getPool(), { userId: user.id, slug }, { plan: str(form, "plan"), period: str(form, "period") });
  });
}

export async function cancelInvoiceAction(slug: string, invoiceId: string) {
  const user = await requireUser();
  await run(`/w/${slug}/paket`, async () => {
    await cancelUpgradeInvoice(getPool(), { userId: user.id, slug }, invoiceId);
  });
}

export type PlanProofTicket = { ok: true; url: string; headers: Record<string, string> } | { ok: false; error: string };

export async function requestPlanProofAction(slug: string, invoiceId: string, input: { filename: string; mime: string; sizeBytes: number }): Promise<PlanProofTicket> {
  const user = await requireUser();
  try {
    const { upload } = await requestPlanProofUpload(getPool(), { userId: user.id, slug }, getStorage(), invoiceId, input);
    return { ok: true, url: upload.url, headers: upload.headers };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function submitPlanProofAction(slug: string, invoiceId: string, note: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  try {
    await submitPlanProof(getPool(), { userId: user.id, slug }, getStorage(), invoiceId, note);
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}
