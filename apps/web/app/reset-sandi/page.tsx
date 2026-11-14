"use client";
import { PasswordInput } from "@/components/password-input";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get("token");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <div className="auth-card">
        <h1>Tautan tidak valid</h1>
        <p>Tautan atur ulang kata sandi tidak valid atau sudah kedaluwarsa.</p>
        <p><Link href="/lupa-sandi">Minta tautan baru</Link></p>
      </div>
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.resetPassword({ newPassword: String(new FormData(e.currentTarget).get("password")), token: token! });
    setBusy(false);
    if (error) {
      setError(error.status === 429 ? "Terlalu banyak percobaan. Coba lagi nanti." : "Tautan tidak valid atau sudah kedaluwarsa, atau kata sandi kurang dari 10 karakter.");
      return;
    }
    router.push("/masuk");
  }

  return (
    <div className="auth-card">
      <h1>Atur kata sandi baru</h1>
      <form onSubmit={onSubmit}>
        <label>Kata sandi baru (minimal 10 karakter)<PasswordInput name="password" required minLength={10} autoComplete="new-password" /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy}>{busy ? "Memproses…" : "Simpan kata sandi"}</button>
      </form>
    </div>
  );
}

export default function ResetSandiPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
