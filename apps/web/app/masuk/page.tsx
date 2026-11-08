"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

function MasukForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const { error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
      callbackURL: target,
    });
    setBusy(false);
    if (error) {
      setError(
        error.status === 429
          ? "Terlalu banyak percobaan. Coba lagi sebentar lagi."
          : error.status === 403
            ? "Email Anda belum diverifikasi. Kami mengirim ulang tautan verifikasi; cek kotak masuk Anda."
            : "Email atau kata sandi salah.",
      );
      return;
    }
    router.push(target);
    router.refresh();
  }

  return (
    <>
      <h1>Masuk</h1>
      <p>Masuk ke akun jadwalin Anda.</p>
      <form onSubmit={onSubmit}>
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        <label>Kata sandi<input name="password" type="password" required autoComplete="current-password" /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy}>{busy ? "Memproses…" : "Masuk"}</button>
      </form>
      <p><small><Link href="/lupa-sandi">Lupa kata sandi?</Link></small></p>
      <small>Belum punya akun? <Link href="/daftar">Daftar</Link></small>
    </>
  );
}

export default function MasukPage() {
  return (
    <Suspense>
      <MasukForm />
    </Suspense>
  );
}
