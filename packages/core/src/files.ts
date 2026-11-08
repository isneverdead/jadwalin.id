import { schema, withWorker, type Db } from "@jadwalin/db";
import { and, desc, eq, lt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getLimits } from "./entitlements";
import { AppError } from "./errors";
import type { PresignedUpload, StorageAdapter } from "./storage";
import { audit, withWorkspace, type Actor, type WorkspaceRef } from "./workspace";

const MB = 1024 * 1024;

/** Nama berkas aman: tanpa path, kontrol, atau karakter berbahaya; ekstensi dipertahankan. */
export function sanitizeFilename(input: string): string {
  const base = input.normalize("NFC").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
  if (!cleaned) return "berkas";
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 120 - ext.length) + ext;
}

export function buildStorageKey(workspaceId: string, fileId: string, filename: string): string {
  return `ws/${workspaceId}/${fileId}/${sanitizeFilename(filename)}`;
}

export interface UploadRequest {
  filename: string;
  mime: string;
  sizeBytes: number;
}

/** Validasi terhadap entitlements workspace. Dipakai juga oleh modul yang membuat berkas sendiri. */
export async function validateUpload(workspaceId: string, req: UploadRequest): Promise<{ filename: string; mime: string }> {
  const limits = await getLimits(workspaceId);
  const mime = req.mime.trim().toLowerCase();
  if (!limits.allowedMimeTypes.includes(mime)) {
    throw new AppError("invalid_input", "Jenis berkas ini tidak diizinkan. Gunakan PDF, gambar, dokumen Office, teks, atau ZIP.");
  }
  if (!Number.isInteger(req.sizeBytes) || req.sizeBytes <= 0) {
    throw new AppError("invalid_input", "Ukuran berkas tidak valid.");
  }
  if (req.sizeBytes > limits.maxFileMb * MB) {
    throw new AppError("invalid_input", `Ukuran berkas maksimal ${limits.maxFileMb} MB.`);
  }
  return { filename: sanitizeFilename(req.filename), mime };
}

/** Primitif untuk modul: buat baris berkas `pending` dan URL unggah dalam konteks workspace yang sudah diotorisasi. */
export async function createPendingFile(
  db: Db,
  access: WorkspaceRef,
  storage: StorageAdapter,
  uploadedBy: string,
  req: UploadRequest,
): Promise<{ fileId: string; upload: PresignedUpload }> {
  const { filename, mime } = await validateUpload(access.workspaceId, req);
  const fileId = randomUUID();
  const storageKey = buildStorageKey(access.workspaceId, fileId, filename);
  await db.insert(schema.files).values({ id: fileId, workspaceId: access.workspaceId, storageKey, filename, mime, sizeBytes: req.sizeBytes, uploadedBy, status: "pending" });
  const upload = await storage.presignUpload({ key: storageKey, mime, sizeBytes: req.sizeBytes });
  return { fileId, upload };
}

export type FinalizeResult = { ok: true; file: typeof schema.files.$inferSelect } | { ok: false; reason: string };

/**
 * Primitif untuk modul: verifikasi objek benar-benar terunggah dengan ukuran/tipe yang dideklarasikan.
 * Penolakan DIKEMBALIKAN (bukan dilempar) agar status `deleted` ikut ter-commit; pemanggil melempar
 * AppError setelah transaksinya selesai (lihat `confirmUpload`).
 */
export async function finalizeFile(db: Db, storage: StorageAdapter, fileId: string): Promise<FinalizeResult> {
  const [file] = await db.select().from(schema.files).where(eq(schema.files.id, fileId)).limit(1);
  if (!file || file.status === "deleted") throw new AppError("not_found", "Berkas tidak ditemukan.");
  if (file.status === "ready") return { ok: true, file };
  const head = await storage.head(file.storageKey);
  if (!head) throw new AppError("invalid_input", "Berkas belum terunggah. Coba unggah lagi.");
  if (head.sizeBytes !== file.sizeBytes || (head.mime && head.mime.toLowerCase() !== file.mime)) {
    await storage.delete(file.storageKey);
    await db.update(schema.files).set({ status: "deleted" }).where(eq(schema.files.id, fileId));
    return { ok: false, reason: "Berkas yang diunggah tidak sesuai dengan yang dideklarasikan." };
  }
  const [ready] = await db.update(schema.files).set({ status: "ready" }).where(eq(schema.files.id, fileId)).returning();
  return { ok: true, file: ready! };
}

/** Primitif untuk modul: URL unduh berumur pendek. Otorisasi domain (mis. akses tiket) dilakukan pemanggil. */
export async function signDownload(db: Db, access: WorkspaceRef, storage: StorageAdapter, actorUserId: string, fileId: string) {
  const [file] = await db.select().from(schema.files).where(eq(schema.files.id, fileId)).limit(1);
  if (!file || file.status !== "ready") throw new AppError("not_found", "Berkas tidak ditemukan.");
  const url = await storage.presignDownload({ key: file.storageKey, filename: file.filename });
  await audit(db, { workspaceId: access.workspaceId, actorUserId, action: "file.download_url_issued", entityType: "file", entityId: file.id });
  return { url, filename: file.filename, mime: file.mime, sizeBytes: file.sizeBytes };
}

// --- API tingkat workspace (staf ke atas) ---------------------------------------------------

export async function requestUpload(pool: pg.Pool, actor: Actor, storage: StorageAdapter, req: UploadRequest) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const result = await createPendingFile(db, access, storage, actor.userId, req);
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "file.upload_requested", entityType: "file", entityId: result.fileId, diff: { filename: req.filename, mime: req.mime, sizeBytes: req.sizeBytes } });
    return result;
  });
}

export async function confirmUpload(pool: pg.Pool, actor: Actor, storage: StorageAdapter, fileId: string) {
  const result = await withWorkspace(pool, actor, "staff", async (db, access) => {
    const [file] = await db.select({ uploadedBy: schema.files.uploadedBy }).from(schema.files).where(eq(schema.files.id, fileId)).limit(1);
    if (!file) throw new AppError("not_found", "Berkas tidak ditemukan.");
    if (file.uploadedBy !== actor.userId && access.role === "staff") throw new AppError("forbidden", "Hanya pengunggah yang bisa mengonfirmasi berkas ini.");
    const outcome = await finalizeFile(db, storage, fileId);
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: outcome.ok ? "file.uploaded" : "file.rejected", entityType: "file", entityId: fileId });
    return outcome;
  });
  if (!result.ok) throw new AppError("invalid_input", result.reason);
  return result.file;
}

export async function getFileDownloadUrl(pool: pg.Pool, actor: Actor, storage: StorageAdapter, fileId: string) {
  return withWorkspace(pool, actor, "staff", (db, access) => signDownload(db, access, storage, actor.userId, fileId));
}

export async function listFiles(pool: pg.Pool, actor: Actor) {
  return withWorkspace(pool, actor, "staff", (db) =>
    db
      .select({ id: schema.files.id, filename: schema.files.filename, mime: schema.files.mime, sizeBytes: schema.files.sizeBytes, uploadedBy: schema.files.uploadedBy, createdAt: schema.files.createdAt })
      .from(schema.files)
      .where(eq(schema.files.status, "ready"))
      .orderBy(desc(schema.files.createdAt))
      .limit(200),
  );
}

export async function deleteFile(pool: pg.Pool, actor: Actor, storage: StorageAdapter, fileId: string) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    const [file] = await db.select().from(schema.files).where(eq(schema.files.id, fileId)).limit(1);
    if (!file || file.status === "deleted") throw new AppError("not_found", "Berkas tidak ditemukan.");
    if (file.uploadedBy !== actor.userId && access.role === "staff") throw new AppError("forbidden", "Hanya pengunggah atau admin yang bisa menghapus berkas ini.");
    await storage.delete(file.storageKey);
    await db.update(schema.files).set({ status: "deleted" }).where(eq(schema.files.id, fileId));
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "file.deleted", entityType: "file", entityId: fileId });
  });
}

/** Worker: hapus unggahan yang tidak pernah dikonfirmasi agar tidak menumpuk di bucket. */
export async function cleanupPendingFiles(pool: pg.Pool, storage: StorageAdapter, opts: { olderThanMs?: number; now?: Date } = {}): Promise<number> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - (opts.olderThanMs ?? 24 * 3600 * 1000));
  const stale = await withWorker(pool, (db) =>
    db.select({ id: schema.files.id, storageKey: schema.files.storageKey }).from(schema.files).where(and(eq(schema.files.status, "pending"), lt(schema.files.createdAt, cutoff))).limit(500),
  );
  for (const f of stale) {
    await storage.delete(f.storageKey).catch(() => undefined);
    await withWorker(pool, (db) => db.update(schema.files).set({ status: "deleted" }).where(and(eq(schema.files.id, f.id), eq(schema.files.status, "pending"))));
  }
  return stale.length;
}
