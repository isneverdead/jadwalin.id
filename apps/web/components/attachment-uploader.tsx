"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type Ticket = { ok: true; fileId: string; url: string; headers: Record<string, string> } | { ok: false; error: string };

/** Unggah langsung ke penyimpanan lewat URL ber-tanda-tangan; server aplikasi tidak memegang isi berkas. */
export function AttachmentUploader({
  request,
  confirm,
  allowHidden,
}: {
  request: (input: { filename: string; mime: string; sizeBytes: number }) => Promise<Ticket>;
  confirm: (input: { fileId: string; contextNote: string; clientVisible: boolean }) => Promise<{ ok: boolean; error?: string }>;
  /** Staf boleh menandai lampiran tidak terlihat klien. */
  allowHidden?: boolean;
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const file = data.get("file") as File | null;
    if (!file || file.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      setStatus("Menyiapkan…");
      const ticket = await request({ filename: file.name, mime: file.type || "application/octet-stream", sizeBytes: file.size });
      if (!ticket.ok) throw new Error(ticket.error);
      setStatus("Mengunggah…");
      const put = await fetch(ticket.url, { method: "PUT", headers: ticket.headers, body: file });
      if (!put.ok) throw new Error("Unggahan ke penyimpanan gagal. Coba lagi.");
      setStatus("Memverifikasi…");
      const done = await confirm({ fileId: ticket.fileId, contextNote: String(data.get("contextNote") ?? ""), clientVisible: allowHidden ? data.get("hidden") !== "on" : true });
      if (!done.ok) throw new Error(done.error ?? "Verifikasi berkas gagal.");
      setStatus(`“${file.name}” terlampir.`);
      form.current?.reset();
      router.refresh();
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : "Terjadi kesalahan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={form} onSubmit={submit}>
      <label>Berkas<small>PDF, gambar, Office, teks, ZIP · maks 10 MB</small><input name="file" type="file" required /></label>
      <label>Catatan konteks (opsional)<input name="contextNote" maxLength={500} placeholder="Mis. “Bukti transfer 3 Nov”" /></label>
      {allowHidden && <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input name="hidden" type="checkbox" style={{ width: 18, height: 18 }} /> Sembunyikan dari klien</label>}
      {status && <p role="status">{status}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button disabled={busy}>{busy ? "Memproses…" : "Lampirkan"}</button>
    </form>
  );
}
