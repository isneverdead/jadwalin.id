"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="auth-card">
      <h1>Terjadi kesalahan</h1>
      <p>Maaf, ada yang tidak berjalan semestinya di pihak kami. Data Anda aman. Coba muat ulang; bila masih terjadi, hubungi kami.</p>
      <p className="row-btns"><button onClick={() => reset()}>Coba lagi</button><a className="btn btn-ghost" href="/dashboard">Ke dashboard</a></p>
    </div>
  );
}
