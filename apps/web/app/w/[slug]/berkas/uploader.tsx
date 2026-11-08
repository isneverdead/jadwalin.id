"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { confirmUploadAction, requestUploadAction } from "@/lib/actions";

export function Uploader({ slug }: { slug: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    const file = input.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setStatus("Menyiapkan unggahan…");
      const ticket = await requestUploadAction(slug, { filename: file.name, mime: file.type || "application/octet-stream", sizeBytes: file.size });
      if (!ticket.ok) throw new Error(ticket.error);

      setStatus("Mengunggah…");
      // Berkas dikirim langsung ke penyimpanan lewat URL ber-tanda-tangan; server aplikasi tidak memegang isinya.
      const put = await fetch(ticket.url, { method: "PUT", headers: ticket.headers, body: file });
      if (!put.ok) throw new Error("Unggahan ke penyimpanan gagal. Coba lagi.");

      setStatus("Memverifikasi…");
      const done = await confirmUploadAction(slug, ticket.fileId);
      if (!done.ok) throw new Error(done.error ?? "Verifikasi berkas gagal.");

      setStatus(`“${file.name}” berhasil diunggah.`);
      if (input.current) input.current.value = "";
      router.refresh();
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : "Terjadi kesalahan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void upload(); }}>
      <label>Pilih berkas (PDF, gambar, Office, teks, ZIP; maks 10 MB)<input ref={input} type="file" required /></label>
      {status && <p role="status">{status}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button disabled={busy}>{busy ? "Memproses…" : "Unggah"}</button>
    </form>
  );
}
