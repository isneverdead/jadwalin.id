"use server";
import {
  AppError,
  acceptInvitation,
  applyBusinessSetup,
  applyBusinessTemplate,
  featuresFromInput,
  setFeatures,
  getBusinessTemplate,
  addOverride,
  confirmUpload,
  inviteMember,
  requestUpload,
  revokeInvitation,
  createMeetingType,
  updateMeetingType,
  createWorkspace,
  deleteWorkspace,
  removeMember,
  removeOverride,
  requestAccountDeletion,
  setMeetingTypeActive,
  setWeeklyAvailability,
  type BusinessSetup,
  type WeeklyRule,
} from "@jadwalin/core";
import { createProduct } from "@jadwalin/module-rental";
import { revalidatePath } from "next/cache";
import { run } from "./run";
import { appBaseUrl, getPool, getStorage, requireUser } from "./server";

export async function createWorkspaceAction(form: FormData) {
  const user = await requireUser();
  await run("/dashboard", async () => {
    const ws = await createWorkspace(getPool(), user.id, {
      name: String(form.get("name") ?? ""),
      slug: String(form.get("slug") ?? ""),
      contactPhone: String(form.get("contactPhone") ?? ""),
    });
    return `/w/${ws.slug}`;
  });
}

/** Rancangan layanan + jam kerja dari form (JSON). Bentuk dicek di sini; isi dicek ulang oleh fungsi jadwal core. */
type SetupWithProducts = BusinessSetup & { products: { name: string; category: string; description: string; pricePerDayIdr: number; depositIdr: number; dpPercent: number; units: number }[] };
function parseSetup(raw: FormDataEntryValue | null): SetupWithProducts | null {
  if (typeof raw !== "string" || !raw) return null;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { throw new AppError("invalid_input", "Data layanan tidak terbaca. Muat ulang halaman."); }
  const o = j as { availability?: unknown; services?: unknown; products?: unknown };
  if (!o || !Array.isArray(o.availability) || !Array.isArray(o.services) || o.availability.length > 28 || o.services.length > 10) throw new AppError("invalid_input", "Data layanan tidak valid.");
  const prods = Array.isArray(o.products) ? o.products : [];
  if (prods.length > 20) throw new AppError("invalid_input", "Maksimal 20 produk saat membuat halaman.");
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    products: prods.map((p: { name?: unknown; category?: unknown; description?: unknown; pricePerDayIdr?: unknown; depositIdr?: unknown; dpPercent?: unknown; units?: unknown }) => ({ name: str(p.name), category: str(p.category), description: str(p.description), pricePerDayIdr: Number(p.pricePerDayIdr) || 0, depositIdr: Number(p.depositIdr) || 0, dpPercent: Number(p.dpPercent) || 0, units: Number(p.units) || 1 })),
    availability: o.availability.map((r: { weekday?: unknown; start?: unknown; end?: unknown }) => ({ weekday: Number(r.weekday), start: str(r.start), end: str(r.end) })),
    services: o.services.map((m: { title?: unknown; durationMin?: unknown; depositIdr?: unknown; locationKind?: unknown; slotStepMin?: unknown }) => ({
      title: str(m.title),
      durationMin: Number(m.durationMin),
      depositIdr: Number(m.depositIdr) || 0,
      locationKind: m.locationKind === "phone" || m.locationKind === "in_person" ? m.locationKind : "link",
      ...(Number(m.slotStepMin) > 0 ? { slotStepMin: Number(m.slotStepMin) } : {}),
    })),
  };
}

/** Buat bisnis dari template (onboarding). Template dicek sebelum bisnis dibuat. */
export async function createBusinessAction(form: FormData) {
  const user = await requireUser();
  const template = String(form.get("template") ?? "kosong");
  await run("/dashboard/bisnis-baru", async () => {
    getBusinessTemplate(template);
    const setup = parseSetup(form.get("setup"));
    const features = featuresFromInput({ jadwal: form.get("feat-jadwal"), tiket: form.get("feat-tiket"), pembayaran: form.get("feat-pembayaran"), berkas: form.get("feat-berkas"), sewa: form.get("feat-sewa") });
    const ws = await createWorkspace(getPool(), user.id, {
      name: String(form.get("name") ?? ""),
      slug: String(form.get("slug") ?? ""),
      features,
      contactPhone: String(form.get("contactPhone") ?? ""),
    });
    // Bila template gagal diterapkan, bisnis tetap ada (nama link sudah terpakai): lanjut ke halamannya.
    const applied = await (setup ? applyBusinessSetup(getPool(), { userId: user.id, slug: ws.slug }, setup, features) : applyBusinessTemplate(getPool(), { userId: user.id, slug: ws.slug }, template, features)).then(() => true, () => false);
    // Produk sewa (bila fitur sewa menyala): dibuat lewat modul rental; gagal sebagian tidak membatalkan halaman yang sudah jadi.
    let productsOk = true;
    if (features.sewa) {
      const list = setup?.products ?? getBusinessTemplate(template).products;
      for (const p of list) {
        await createProduct(getPool(), { userId: user.id, slug: ws.slug }, { name: p.name, category: p.category, description: p.description, pricePerDayIdr: p.pricePerDayIdr, depositIdr: p.depositIdr, dpPercent: features.pembayaran ? p.dpPercent : 0, units: p.units }).catch(() => { productsOk = false; });
      }
    }
    return applied && productsOk ? `/w/${ws.slug}?baru=${encodeURIComponent(template)}` : `/w/${ws.slug}`;
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

export async function updateMeetingTypeAction(slug: string, meetingTypeId: string, form: FormData) {
  const user = await requireUser();
  const kind = String(form.get("locationKind"));
  const dp = form.get("depositIdr");
  await run(`/w/${slug}/jadwal`, async () => {
    await updateMeetingType(getPool(), { userId: user.id, slug }, meetingTypeId, {
      title: String(form.get("title") ?? ""),
      durationMin: Number(form.get("durationMin")),
      depositIdr: dp === "" || dp === null ? 0 : Number(dp),
      locationKind: kind === "phone" || kind === "in_person" ? kind : "link",
      locationValue: String(form.get("locationValue") ?? ""),
    });
    return `/w/${slug}/jadwal?tersimpan=1#layanan`;
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

/** Ubah fitur usaha (admin/pemilik). Penegakan dan aturan "tidak boleh mematikan pembayaran yang masih dipakai" ada di core. */
export async function saveFeaturesAction(slug: string, form: FormData) {
  const user = await requireUser();
  await run(`/w/${slug}/pengaturan`, async () => {
    await setFeatures(getPool(), { userId: user.id, slug }, featuresFromInput({ jadwal: form.get("jadwal"), tiket: form.get("tiket"), pembayaran: form.get("pembayaran"), berkas: form.get("berkas"), sewa: form.get("sewa") }));
    revalidatePath(`/w/${slug}`, "layout");
    return `/w/${slug}/pengaturan?tersimpan=1`;
  });
}

/** Hapus halaman jadwal (hanya pemilik; harus mengetik nama persis). Soft delete di core. */
export async function deleteWorkspaceAction(slug: string, form: FormData) {
  const user = await requireUser();
  await run(`/w/${slug}/pengaturan`, async () => {
    await deleteWorkspace(getPool(), { userId: user.id, slug }, String(form.get("confirmName") ?? ""));
    revalidatePath("/dashboard");
    return "/dashboard?dihapus=1";
  });
}
