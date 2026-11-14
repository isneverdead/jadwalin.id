"use server";
import { adminReviewInvoice, adminSetPlan, adminSetSuspended } from "@jadwalin/core";
import { run } from "./run";
import { getPool, requireSuperadmin, superadminEmails } from "./server";

const str = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function reviewInvoiceAction(invoiceId: string, form: FormData) {
  const admin = await requireSuperadmin();
  const approve = str(form, "decision") === "approve";
  await run("/admin/upgrade", async () => {
    await adminReviewInvoice(getPool(), admin.id, superadminEmails(), invoiceId, approve ? { approve: true } : { approve: false, reason: str(form, "reason") });
  });
}

export async function setPlanAction(workspaceId: string, form: FormData) {
  const admin = await requireSuperadmin();
  await run("/admin/pengguna", async () => {
    const until = str(form, "until");
    await adminSetPlan(getPool(), admin.id, superadminEmails(), workspaceId, str(form, "plan"), until ? new Date(`${until}T23:59:59Z`) : null);
  });
}

export async function setSuspendedAction(userId: string, suspended: boolean) {
  const admin = await requireSuperadmin();
  await run("/admin/pengguna", async () => {
    await adminSetSuspended(getPool(), admin.id, superadminEmails(), userId, suspended);
  });
}
