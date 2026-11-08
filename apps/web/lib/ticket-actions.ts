"use server";
import { AppError } from "@jadwalin/core";
import {
  addClientComment,
  addStaffComment,
  assignTicket,
  cancelTicketMeeting,
  confirmAttachment,
  confirmClientAttachment,
  createClientTicket,
  createTicket,
  requestAttachmentUpload,
  requestClientAttachmentUpload,
  scheduleTicketMeeting,
  setMyTicketStatus,
  setTicketPriority,
  setTicketStatus,
  TICKET_STATUSES,
  type Priority,
  type TicketStatus,
} from "@jadwalin/module-tickets";
import { revalidatePath } from "next/cache";
import { run } from "./run";
import { appBaseUrl, getPool, getStorage, requireUser } from "./server";
import type { UploadTicket } from "./actions";

const opts = () => ({ baseUrl: appBaseUrl() });
const str = (form: FormData, key: string) => String(form.get(key) ?? "");

// ---------- Staf ----------

export async function createTicketStaffAction(slug: string, form: FormData) {
  const user = await requireUser();
  await run(`/w/${slug}/tiket`, async () => {
    const t = await createTicket(
      getPool(),
      { userId: user.id, slug },
      { clientId: str(form, "clientId"), title: str(form, "title"), description: str(form, "description"), priority: (str(form, "priority") || "normal") as Priority, assigneeMemberId: str(form, "assignee") || null },
      opts(),
    );
    return `/w/${slug}/tiket/${t.number}`;
  });
}

export async function setStatusAction(slug: string, number: number, form: FormData) {
  const user = await requireUser();
  const to = str(form, "status") as TicketStatus;
  await run(`/w/${slug}/tiket/${number}`, async () => {
    if (!TICKET_STATUSES.includes(to)) throw new AppError("invalid_input", "Status tidak valid.");
    await setTicketStatus(getPool(), { userId: user.id, slug }, number, to, opts());
  });
}

export async function setPriorityAction(slug: string, number: number, form: FormData) {
  const user = await requireUser();
  await run(`/w/${slug}/tiket/${number}`, async () => {
    await setTicketPriority(getPool(), { userId: user.id, slug }, number, str(form, "priority") as Priority);
  });
}

export async function assignAction(slug: string, number: number, form: FormData) {
  const user = await requireUser();
  await run(`/w/${slug}/tiket/${number}`, async () => {
    await assignTicket(getPool(), { userId: user.id, slug }, number, str(form, "assignee") || null, opts());
  });
}

export async function staffCommentAction(slug: string, number: number, form: FormData) {
  const user = await requireUser();
  await run(`/w/${slug}/tiket/${number}`, async () => {
    await addStaffComment(getPool(), { userId: user.id, slug }, number, { body: str(form, "body"), internal: form.get("internal") === "on" }, opts());
  });
}

export async function scheduleMeetingAction(slug: string, number: number, form: FormData) {
  const user = await requireUser();
  await run(`/w/${slug}/tiket/${number}`, async () => {
    const startsAt = new Date(str(form, "startsAt"));
    if (Number.isNaN(startsAt.getTime())) throw new AppError("invalid_input", "Pilih slot waktu terlebih dulu.");
    await scheduleTicketMeeting(getPool(), { userId: user.id, slug }, number, { meetingTypeId: str(form, "meetingTypeId"), startsAt, notes: str(form, "notes") }, opts());
  });
}

export async function cancelMeetingAction(slug: string, number: number, bookingId: string) {
  const user = await requireUser();
  await run(`/w/${slug}/tiket/${number}`, async () => {
    await cancelTicketMeeting(getPool(), { userId: user.id, slug }, number, bookingId, opts());
  });
}

export async function requestStaffAttachmentAction(slug: string, number: number, input: { filename: string; mime: string; sizeBytes: number }): Promise<UploadTicket> {
  const user = await requireUser();
  try {
    const { fileId, upload } = await requestAttachmentUpload(getPool(), { userId: user.id, slug }, getStorage(), number, input);
    return { ok: true, fileId, url: upload.url, headers: upload.headers };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function confirmStaffAttachmentAction(slug: string, number: number, input: { fileId: string; contextNote: string; clientVisible: boolean }): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  try {
    await confirmAttachment(getPool(), { userId: user.id, slug }, getStorage(), number, input);
    revalidatePath(`/w/${slug}/tiket/${number}`);
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

// ---------- Klien ----------

export async function createClientTicketAction(slug: string, form: FormData) {
  const user = await requireUser();
  await run(`/jadwal-saya/${slug}`, async () => {
    const t = await createClientTicket(getPool(), user.id, slug, { title: str(form, "title"), description: str(form, "description") }, opts());
    return `/jadwal-saya/${slug}/tiket/${t.number}`;
  });
}

export async function clientCommentAction(slug: string, number: number, form: FormData) {
  const user = await requireUser();
  await run(`/jadwal-saya/${slug}/tiket/${number}`, async () => {
    await addClientComment(getPool(), user.id, slug, number, str(form, "body"), opts());
  });
}

export async function clientSetStatusAction(slug: string, number: number, to: "closed" | "open") {
  const user = await requireUser();
  await run(`/jadwal-saya/${slug}/tiket/${number}`, async () => {
    await setMyTicketStatus(getPool(), user.id, slug, number, to);
  });
}

export async function requestClientAttachmentAction(slug: string, number: number, input: { filename: string; mime: string; sizeBytes: number }): Promise<UploadTicket> {
  const user = await requireUser();
  try {
    const { fileId, upload } = await requestClientAttachmentUpload(getPool(), user.id, slug, getStorage(), number, input);
    return { ok: true, fileId, url: upload.url, headers: upload.headers };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function confirmClientAttachmentAction(slug: string, number: number, input: { fileId: string; contextNote: string; clientVisible: boolean }): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  try {
    await confirmClientAttachment(getPool(), user.id, slug, getStorage(), number, { fileId: input.fileId, contextNote: input.contextNote });
    revalidatePath(`/jadwal-saya/${slug}/tiket/${number}`);
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}
