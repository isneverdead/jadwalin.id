import Link from "next/link";

export default function NotFound() {
  return (
    <div className="auth-card">
      <h1>Halaman tidak ditemukan</h1>
      <p>Alamat yang Anda buka tidak ada atau sudah dipindahkan. Periksa kembali linknya, atau kembali ke awal.</p>
      <p className="row-btns"><Link className="btn" href="/">Ke beranda</Link><Link className="btn btn-ghost" href="/dashboard">Dashboard</Link></p>
    </div>
  );
}
