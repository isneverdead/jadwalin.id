"use client";
import { PasswordInput } from "@/components/password-input";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

export default function DaftarPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const phone = String(form.get("phone") ?? "").trim();
    const email = String(form.get("email"));
    const { error } = await authClient.signUp.email({
      name: String(form.get("name")),
      email,
      password: String(form.get("password")),
      callbackURL: "/dashboard",
      ...({ termsAccepted: form.get("terms") === "on" } as object),
      ...(phone ? { phone } : {}),
    });
    setBusy(false);
    if (error) {
      setError(
        error.status === 429
          ? "Terlalu banyak percobaan. Coba lagi nanti."
          : error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" || error.code === "USER_ALREADY_EXISTS"
            ? "Email ini sudah terdaftar. Silakan masuk."
            : "Pendaftaran gagal. Pastikan kata sandi minimal 10 karakter dan nomor HP valid.",
      );
      return;
    }
    setSentTo(email);
  }

  if (sentTo) {
    return (
      <div className="auth-card">
        <h1>Cek email Anda</h1>
        <p>Kami mengirim tautan verifikasi ke <strong>{sentTo}</strong>. Klik tautan itu untuk menyelesaikan pendaftaran, lalu masuk.</p>
        <p><small>Tidak menerima? Coba masuk, dan kami akan mengirim ulang tautannya. Periksa folder spam.</small></p>
        <p><Link href="/masuk">Ke halaman masuk</Link></p>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h1>Daftar</h1>
      <p>Buat akun jadwalin. Satu akun bisa dipakai sebagai penyedia jasa maupun klien.</p>
      <form onSubmit={onSubmit}>
        <label>Nama<input name="name" required autoComplete="name" /></label>
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        <label>Nomor HP (opsional)<input name="phone" type="tel" autoComplete="tel" placeholder="0812…" /></label>
        <label>Kata sandi (minimal 10 karakter)<PasswordInput name="password" required minLength={10} autoComplete="new-password" /></label>
        <label className="check"><input type="checkbox" name="terms" required /><span>Saya menyetujui <Link href="/syarat" target="_blank">Syarat Layanan</Link> dan <Link href="/privasi" target="_blank">Kebijakan Privasi</Link>.</span></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy}>{busy ? "Memproses…" : "Daftar"}</button>
      </form>
      <small>Sudah punya akun? <Link href="/masuk">Masuk</Link></small>
    </div>
  );
}
