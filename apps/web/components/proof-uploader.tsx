"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { requestProofAction, submitProofAction } from "@/lib/payment-actions";

const MAX = 5 * 1024 * 1024;

/** Pelanggan mengunggah bukti bayar (gambar/PDF ≤ 5 MB) langsung ke penyimpanan lewat URL bertanda tangan. */
export function ProofUploader({ token }: { token: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    const file = input.current?.files?.[0];
    if (!file) return;
    if (file.size > MAX) { setError("Ukuran bukti maksimal 5 MB."); return; }
    setBusy(true);
    setError(null);
    try {
      setStatus("Menyiapkan…");
      const t = await requestProofAction(token, { filename: file.name, mime: file.type || "application/octet-stream", sizeBytes: file.size });
      if (!t.ok) throw new Error(t.error);
      setStatus("Mengunggah…");
      const put = await fetch(t.url, { method: "PUT", headers: t.headers, body: file });
      if (!put.ok) throw new Error("Unggahan gagal. Coba lagi.");
      setStatus("Mengirim bukti…");
      const done = await submitProofAction(token, t.fileId, note);
      if (!done.ok) throw new Error(done.error ?? "Gagal mengirim bukti.");
      setStatus(null);
      router.refresh();
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : "Terjadi kesalahan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <label><span>Bukti transfer / pembayaran <small>(gambar atau PDF, maks 5 MB)</small></span><input ref={input} type="file" required accept="image/png,image/jpeg,image/webp,application/pdf" capture={undefined} /></label>
      <label><span>Catatan <small>(opsional, mis. nama pengirim)</small></span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Transfer dari BCA a.n. …" /></label>
      {status && <p role="status">{status}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="cta" disabled={busy}>{busy ? "Memproses…" : "Kirim bukti pembayaran"}</button>
    </form>
  );
}
