"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

export default function LupaSandiPage() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.requestPasswordReset({
      email: String(new FormData(e.currentTarget).get("email")),
      redirectTo: `${window.location.origin}/reset-sandi`,
    });
    setBusy(false);
    if (error?.status === 429) {
      setError("Terlalu banyak permintaan. Coba lagi nanti.");
      return;
    }
    // Pesan sama untuk email terdaftar maupun tidak (tidak membocorkan akun).
    setDone(true);
  }

  if (done) {
    return (
      <>
        <h1>Cek email Anda</h1>
        <p>Jika email itu terdaftar, kami telah mengirim tautan untuk mengatur ulang kata sandi. Tautan berlaku 1 jam.</p>
        <p><Link href="/masuk">Kembali ke halaman masuk</Link></p>
      </>
    );
  }

  return (
    <>
      <h1>Lupa kata sandi</h1>
      <p>Masukkan email akun Anda. Kami kirim tautan untuk mengatur ulang kata sandi.</p>
      <form onSubmit={onSubmit}>
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy}>{busy ? "Memproses…" : "Kirim tautan"}</button>
      </form>
      <small><Link href="/masuk">Kembali</Link></small>
    </>
  );
}
