"use server";
import {
  AppError,
  acceptInvitation,
  addOverride,
  confirmUpload,
  inviteMember,
  requestUpload,
  revokeInvitation,
  createMeetingType,
  createWorkspace,
  removeMember,
  removeOverride,
  requestAccountDeletion,
  setMeetingTypeActive,
  setWeeklyAvailability,
  type WeeklyRule,
} from "@jadwalin/core";
import { revalidatePath } from "next/cache";
import { run } from "./run";
import { appBaseUrl, getPool, getStorage, requireUser } from "./server";

export async function createWorkspaceAction(form: FormData) {
  const user = await requireUser();
  await run("/dashboard", async () => {
    const ws = await createWorkspace(getPool(), user.id, {
      name: String(form.get("name") ?? ""),
      slug: String(form.get("slug") ?? ""),
    });
    return `/w/${ws.slug}`;
  });
}

export async function inviteMemberAction(slug: string, form: FormData) {
  const user = await requireUser();
  const role = form.get("role") === "admin" ? "admin" : "staff";
  await run(`/w/${slug}`, async () => {
    await inviteMember(getPool(), { userId: user.id, slug }, { email: String(form.get("email") ?? ""), role }, { baseUrl: appBaseUrl() });
  });
}

export async function revokeInvitationAction(slug: string, invitationId: string) {
  const user = await requireUser();
  await run(`/w/${slug}`, async () => {
    await revokeInvitation(getPool(), { userId: user.id, slug }, invitationId);
  });
}

export async function acceptInvitationAction(token: string) {
  const user = await requireUser();
  await run(`/undangan/${token}`, async () => {
    const { slug } = await acceptInvitation(getPool(), user.id, token);
    return `/w/${slug}`;
  });
}

export async function removeMemberAction(slug: string, memberId: string) {
  const user = await requireUser();
  await run(`/w/${slug}`, async () => {
    await removeMember(getPool(), { userId: user.id, slug }, memberId);
  });
}

export async function saveWeeklyAction(slug: string, form: FormData) {
  const user = await requireUser();
  const rules: WeeklyRule[] = [];
  for (let weekday = 0; weekday <= 6; weekday++) {
    if (form.get(`on-${weekday}`) !== "on") continue;
    rules.push({ weekday, start: String(form.get(`start-${weekday}`) ?? ""), end: String(form.get(`end-${weekday}`) ?? "") });
  }
  await run(`/w/${slug}/jadwal`, async () => {
    await setWeeklyAvailability(getPool(), { userId: user.id, slug }, { rules });
  });
}

export async function addOverrideAction(slug: string, form: FormData) {
  const user = await requireUser();
  const kind = form.get("kind") === "extra" ? "extra" : "blocked";
  await run(`/w/${slug}/jadwal`, async () => {
    await addOverride(getPool(), { userId: user.id, slug }, {
      date: String(form.get("date") ?? ""),
      kind,
      start: String(form.get("start") ?? ""),
      end: String(form.get("end") ?? ""),
    });
  });
}

export async function removeOverrideAction(slug: string, overrideId: string) {
  const user = await requireUser();
  await run(`/w/${slug}/jadwal`, async () => {
    await removeOverride(getPool(), { userId: user.id, slug }, overrideId);
  });
}

export async function createMeetingTypeAction(slug: string, form: FormData) {
  const user = await requireUser();
  const kind = String(form.get("locationKind"));
  const num = (key: string) => (form.get(key) === "" || form.get(key) === null ? undefined : Number(form.get(key)));
  await run(`/w/${slug}/jadwal`, async () => {
    await createMeetingType(getPool(), { userId: user.id, slug }, {
      slug: String(form.get("code") ?? ""),
      title: String(form.get("title") ?? ""),
      durationMin: Number(form.get("durationMin")),
      slotStepMin: num("slotStepMin"),
      bufferBeforeMin: num("bufferBeforeMin"),
      bufferAfterMin: num("bufferAfterMin"),
      minNoticeMin: num("minNoticeMin"),
      maxDaysAhead: num("maxDaysAhead"),
      locationKind: kind === "phone" || kind === "in_person" ? kind : "link",
      locationValue: String(form.get("locationValue") ?? ""),
      depositIdr: num("depositIdr"),
    });
  });
}

export async function toggleMeetingTypeAction(slug: string, meetingTypeId: string, active: boolean) {
  const user = await requireUser();
  await run(`/w/${slug}/jadwal`, async () => {
    await setMeetingTypeActive(getPool(), { userId: user.id, slug }, meetingTypeId, active);
  });
}

export type UploadTicket = { ok: true; fileId: string; url: string; headers: Record<string, string> } | { ok: false; error: string };

/** Dipanggil dari komponen klien: mengembalikan URL unggah ber-tanda-tangan (berkas langsung ke penyimpanan, bukan lewat server ini). */
export async function requestUploadAction(slug: string, input: { filename: string; mime: string; sizeBytes: number }): Promise<UploadTicket> {
  const user = await requireUser();
  try {
    const { fileId, upload } = await requestUpload(getPool(), { userId: user.id, slug }, getStorage(), input);
    return { ok: true, fileId, url: upload.url, headers: upload.headers };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function confirmUploadAction(slug: string, fileId: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  try {
    await confirmUpload(getPool(), { userId: user.id, slug }, getStorage(), fileId);
    revalidatePath(`/w/${slug}/berkas`);
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function requestDeletionAction() {
  const user = await requireUser();
  await run("/akun", async () => {
    await requestAccountDeletion(getPool(), user.id);
    return "/akun?ok=1";
  });
}
