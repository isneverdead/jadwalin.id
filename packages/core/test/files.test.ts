import { createPool } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addClient,
  AppError,
  buildStorageKey,
  cleanupPendingFiles,
  confirmUpload,
  contentDisposition,
  createWorkspace,
  deleteFile,
  getFileDownloadUrl,
  listFiles,
  requestUpload,
  S3Storage,
  sanitizeFilename,
} from "../src";
import { inviteAndAccept } from "./helpers";

describe("sanitizeFilename", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\x\\laporan.pdf", "laporan.pdf"],
    ["  .hidden  ", "hidden"],
    ["a<b>c:d\"e|f?g*.txt", "abcdefg.txt"],
    ["", "berkas"],
    ["\u0000\u0001", "berkas"],
  ])("%j -> %j", (input, expected) => expect(sanitizeFilename(input)).toBe(expected));

  it("nama panjang dipotong tetapi ekstensi dipertahankan", () => {
    const out = sanitizeFilename(`${"a".repeat(300)}.pdf`);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("Content-Disposition selalu attachment dan aman untuk karakter non-ASCII/kutip", () => {
    const h = contentDisposition('laporan "Q1" ñ.pdf');
    expect(h.startsWith("attachment;")).toBe(true);
    expect(h).not.toMatch(/filename="[^"]*"[^;]*"/); // tidak ada kutip lolos
    expect(h).toContain("filename*=UTF-8''");
  });

  it("kunci penyimpanan terikat workspace", () => {
    expect(buildStorageKey("w1", "f1", "a/b.pdf")).toBe("ws/w1/f1/b.pdf");
  });
});

const url = process.env.DATABASE_URL;
const s3 = {
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
};
const haveS3 = Boolean(s3.endpoint && s3.bucket && s3.accessKeyId && s3.secretAccessKey);
const sfx = Math.random().toString(36).slice(2, 8);
const PDF = new TextEncoder().encode("%PDF-1.4 uji");

describe.skipIf(!url || !haveS3)("penyimpanan berkas (Postgres + S3 asli)", () => {
  let pool: pg.Pool;
  let storage: S3Storage;
  const u = {} as Record<"owner" | "staff" | "outsider" | "admin", string>;
  let slug: string;
  let otherSlug: string;
  const owner = () => ({ userId: u.owner, slug });
  const staff = () => ({ userId: u.staff, slug });
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${e}`));

  const put = (up: { url: string; headers: Record<string, string> }, body: Uint8Array, headers?: Record<string, string>) =>
    fetch(up.url, { method: "PUT", headers: headers ?? up.headers, body: body as unknown as BodyInit });

  async function uploadPdf(actor = owner(), name = "laporan.pdf") {
    const { fileId, upload } = await requestUpload(pool, actor, storage, { filename: name, mime: "application/pdf", sizeBytes: PDF.byteLength });
    const res = await put(upload, PDF);
    expect(res.ok).toBe(true);
    await confirmUpload(pool, actor, storage, fileId);
    return fileId;
  }

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    storage = new S3Storage({ endpoint: s3.endpoint, region: "auto", bucket: s3.bucket!, accessKeyId: s3.accessKeyId!, secretAccessKey: s3.secretAccessKey!, forcePathStyle: true });
    await storage.ensureBucket(); // tanpa CORS: tes memakai fetch Node dan tak boleh menimpa CORS milik dev server/E2E
    for (const k of ["owner", "staff", "outsider", "admin"] as const) {
      u[k] = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, $2, true) RETURNING id`, [`${k}-${sfx}@files.local`, k])).rows[0].id;
    }
    slug = `berkas-${sfx}`;
    otherSlug = `berkas-lain-${sfx}`;
    await createWorkspace(pool, u.owner, { name: "Berkas", slug });
    await createWorkspace(pool, u.outsider, { name: "Lain", slug: otherSlug });
    await inviteAndAccept(pool, owner(), { userId: u.staff, email: `staff-${sfx}@files.local`, role: "staff" });
    await inviteAndAccept(pool, owner(), { userId: u.admin, email: `admin-${sfx}@files.local`, role: "admin" });
    void addClient;
  });
  afterAll(async () => pool?.end());

  it("unggah → konfirmasi → unduh: isi sama, dipaksa attachment, URL berumur pendek", async () => {
    const id = await uploadPdf();
    const dl = await getFileDownloadUrl(pool, owner(), storage, id);
    expect(new URL(dl.url).searchParams.get("X-Amz-Expires")).toBe("60");
    const res = await fetch(dl.url);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect((await listFiles(pool, staff())).map((f) => f.id)).toContain(id);
  });

  it("URL unggah ditandatangani 5 menit dan terikat tipe isi", async () => {
    const { upload } = await requestUpload(pool, owner(), storage, { filename: "x.pdf", mime: "application/pdf", sizeBytes: PDF.byteLength });
    expect(new URL(upload.url).searchParams.get("X-Amz-Expires")).toBe("300");
    const wrongType = await put(upload, PDF, { "Content-Type": "text/html" });
    expect(wrongType.ok).toBe(false); // tanda tangan tidak cocok
  });

  it("validasi: tipe tak diizinkan, ukuran 0, ukuran melebihi batas", async () => {
    expect(await code(requestUpload(pool, owner(), storage, { filename: "a.html", mime: "text/html", sizeBytes: 10 }))).toBe("invalid_input");
    expect(await code(requestUpload(pool, owner(), storage, { filename: "a.svg", mime: "image/svg+xml", sizeBytes: 10 }))).toBe("invalid_input");
    expect(await code(requestUpload(pool, owner(), storage, { filename: "a.pdf", mime: "application/pdf", sizeBytes: 0 }))).toBe("invalid_input");
    expect(await code(requestUpload(pool, owner(), storage, { filename: "a.pdf", mime: "application/pdf", sizeBytes: 11 * 1024 * 1024 }))).toBe("invalid_input");
  });

  it("konfirmasi tanpa unggahan gagal; ukuran tidak cocok ditolak dan objek dihapus", async () => {
    const a = await requestUpload(pool, owner(), storage, { filename: "belum.pdf", mime: "application/pdf", sizeBytes: 10 });
    expect(await code(confirmUpload(pool, owner(), storage, a.fileId))).toBe("invalid_input");

    // Objek ditaruh langsung dengan ukuran berbeda dari yang dideklarasikan (mensimulasikan kegagalan penegakan di sisi penyimpanan).
    const b = await requestUpload(pool, owner(), storage, { filename: "beda.pdf", mime: "application/pdf", sizeBytes: 10 });
    const key = (await pool.query(`SELECT storage_key FROM files WHERE id = $1`, [b.fileId])).rows[0].storage_key;
    await storage.putForTest(key, new Uint8Array(25), "application/pdf");
    expect(await code(confirmUpload(pool, owner(), storage, b.fileId))).toBe("invalid_input");
    expect(await storage.head(key)).toBeNull();
    expect((await pool.query(`SELECT status FROM files WHERE id = $1`, [b.fileId])).rows[0].status).toBe("deleted");
  });

  it("akses: bukan anggota dan workspace lain tidak bisa mengunduh, mengunggah, atau melihat daftar", async () => {
    const id = await uploadPdf();
    expect(await code(getFileDownloadUrl(pool, { userId: u.outsider, slug }, storage, id))).toBe("not_found");
    expect(await code(requestUpload(pool, { userId: u.outsider, slug }, storage, { filename: "a.pdf", mime: "application/pdf", sizeBytes: 5 }))).toBe("not_found");
    // anggota workspace lain memakai id berkas milik workspace ini lewat workspace mereka sendiri
    expect(await code(getFileDownloadUrl(pool, { userId: u.outsider, slug: otherSlug }, storage, id))).toBe("not_found");
    expect((await listFiles(pool, { userId: u.outsider, slug: otherSlug })).map((f) => f.id)).not.toContain(id);
  });

  it("hapus: staf bukan pengunggah ditolak, admin boleh; objek benar-benar hilang", async () => {
    const id = await uploadPdf();
    const key = (await pool.query(`SELECT storage_key FROM files WHERE id = $1`, [id])).rows[0].storage_key;
    expect(await code(deleteFile(pool, staff(), storage, id))).toBe("forbidden");
    expect(await code(deleteFile(pool, { userId: u.admin, slug }, storage, id))).toBe("ok");
    expect(await storage.head(key)).toBeNull();
    expect(await code(getFileDownloadUrl(pool, owner(), storage, id))).toBe("not_found");
  });

  it("URL unduh kedaluwarsa setelah umurnya habis", async () => {
    const id = await uploadPdf();
    const key = (await pool.query(`SELECT storage_key FROM files WHERE id = $1`, [id])).rows[0].storage_key;
    const short = await storage.presignDownload({ key, filename: "x.pdf", expiresInSec: 1 });
    expect((await fetch(short)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2500));
    expect((await fetch(short)).status).toBe(403);
  });

  it("pembersihan: unggahan pending lama dihapus oleh worker, yang baru dibiarkan", async () => {
    const old = await requestUpload(pool, owner(), storage, { filename: "yatim.pdf", mime: "application/pdf", sizeBytes: 5 });
    const key = (await pool.query(`SELECT storage_key FROM files WHERE id = $1`, [old.fileId])).rows[0].storage_key;
    await storage.putForTest(key, new Uint8Array(5), "application/pdf");
    expect(await cleanupPendingFiles(pool, storage, { olderThanMs: 24 * 3600_000 })).toBeGreaterThanOrEqual(0);
    expect((await pool.query(`SELECT status FROM files WHERE id = $1`, [old.fileId])).rows[0].status).toBe("pending");
    await cleanupPendingFiles(pool, storage, { olderThanMs: 24 * 3600_000, now: new Date(Date.now() + 48 * 3600_000) });
    expect((await pool.query(`SELECT status FROM files WHERE id = $1`, [old.fileId])).rows[0].status).toBe("deleted");
    expect(await storage.head(key)).toBeNull();
  });

  it("audit: URL unduh yang diterbitkan tercatat", async () => {
    const r = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = $1) AND action = 'file.download_url_issued'`, [slug]);
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
