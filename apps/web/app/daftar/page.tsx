import Link from "next/link";
import { DaftarForm } from "./daftar-form";

export default function DaftarPage() {
  if (process.env.SIGNUP_CLOSED === "true") {
    return (
      <div className="auth-card">
        <h1>Pendaftaran ditutup sementara</h1>
        <p>Saat ini jadwalin.id belum menerima akun baru. Silakan kembali lagi nanti.</p>
        <p><Link href="/masuk">Sudah punya akun? Masuk</Link></p>
      </div>
    );
  }
  return <DaftarForm />;
}
