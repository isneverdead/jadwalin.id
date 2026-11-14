"use client";
import { useRef, useState } from "react";
import { confirmUploadAction, requestUploadAction } from "@/lib/actions";

/** Unggah gambar QRIS statis lewat modul berkas; mengisi input tersembunyi `qrisFileId` pada form induk. */
export function QrisUploader({ slug }: { slug: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [fileId, setFileId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    const file = input.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setFileId("");
    try {
      if (!file.type.startsWith("image/")) throw new Error("QRIS harus berupa gambar (PNG/JPG/WebP).");
      const t = await requestUploadAction(slug, { filename: file.name, mime: file.type, sizeBytes: file.size });
      if (!t.ok) throw new Error(t.error);
      const put = await fetch(t.url, { method: "PUT", headers: t.headers, body: file });
      if (!put.ok) throw new Error("Unggahan gagal. Coba lagi.");
      const done = await confirmUploadAction(slug, t.fileId);
      if (!done.ok) throw new Error(done.error ?? "Verifikasi berkas gagal.");
      setFileId(t.fileId);
      setStatus(`“${file.name}” siap dipakai.`);
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : "Terjadi kesalahan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="qris-up">
      <label><span>Gambar QRIS <small>(wajib untuk jenis QRIS)</small></span><input ref={input} type="file" accept="image/png,image/jpeg,image/webp" onChange={() => void upload()} /></label>
      <input type="hidden" name="qrisFileId" value={fileId} />
      {busy && <p role="status">Mengunggah…</p>}
      {status && <p role="status">✓ {status}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
