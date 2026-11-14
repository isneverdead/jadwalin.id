"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { completeRefundAction, requestRefundProofAction } from "@/lib/change-actions";

const MAX = 5 * 1024 * 1024;

/** Penyedia jasa mengunggah bukti transfer refund (gambar/PDF ≤ 5 MB); setelah itu booking dibatalkan dan pelanggan bisa melihat buktinya. */
export function RefundProofUploader({ slug, requestId, amount }: { slug: string; requestId: string; amount: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
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
      const t = await requestRefundProofAction(slug, requestId, { filename: file.name, mime: file.type || "application/octet-stream", sizeBytes: file.size });
      if (!t.ok) throw new Error(t.error);
      setStatus("Mengunggah…");
      const put = await fetch(t.url, { method: "PUT", headers: t.headers, body: file });
      if (!put.ok) throw new Error("Unggahan gagal. Coba lagi.");
      setStatus("Menyelesaikan refund…");
      const done = await completeRefundAction(slug, requestId);
      if (!done.ok) throw new Error(done.error ?? "Gagal menyelesaikan refund.");
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
    <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="refund-up">
      <label><span>Bukti transfer refund {amount} <small>(gambar atau PDF, maks 5 MB)</small></span><input ref={input} type="file" required accept="image/png,image/jpeg,image/webp,application/pdf" /></label>
      {status && <p role="status">{status}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="cta" disabled={busy}>{busy ? "Memproses…" : "Unggah bukti & selesaikan refund"}</button>
      <small>Setelah ini booking resmi dibatalkan, slot dilepas, dan pelanggan bisa melihat bukti ini.</small>
    </form>
  );
}
