"use client";
import { useRef, useState } from "react";
import { confirmUploadAction } from "@/lib/actions";
import { requestProductImageAction } from "@/lib/rental-actions";

/** Unggah foto produk (PNG/JPG/WebP ≤ 5 MB); mengisi input tersembunyi `imageFileId` pada form induk. */
export function ProductImageUploader({ slug, currentUrl }: { slug: string; currentUrl?: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [fileId, setFileId] = useState("");
  const [preview, setPreview] = useState<string | null>(currentUrl ?? null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    const file = input.current?.files?.[0];
    if (!file) return;
    setBusy(true); setError(null); setStatus(null); setFileId("");
    try {
      if (!file.type.startsWith("image/")) throw new Error("Foto harus berupa gambar (PNG/JPG/WebP).");
      const t = await requestProductImageAction(slug, { filename: file.name, mime: file.type, sizeBytes: file.size });
      if (!t.ok) throw new Error(t.error);
      const put = await fetch(t.url, { method: "PUT", headers: t.headers, body: file });
      if (!put.ok) throw new Error("Unggahan gagal. Coba lagi.");
      const done = await confirmUploadAction(slug, t.fileId);
      if (!done.ok) throw new Error(done.error ?? "Verifikasi berkas gagal.");
      setFileId(t.fileId);
      setPreview(URL.createObjectURL(file));
      setStatus("Foto siap disimpan.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="img-up">
      <div className="img-up-preview" aria-hidden={!preview}>
        {preview ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={preview} alt="Pratinjau foto produk" /> : <span>Belum ada foto</span>}
      </div>
      <div className="img-up-controls">
        <label>Foto produk <small>(PNG/JPG/WebP, maks 5 MB)</small>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" onChange={() => void upload()} />
        </label>
        <input type="hidden" name="imageFileId" value={fileId} />
        {busy && <small role="status">Mengunggah…</small>}
        {status && <small role="status" className="ok-text">✓ {status}</small>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
