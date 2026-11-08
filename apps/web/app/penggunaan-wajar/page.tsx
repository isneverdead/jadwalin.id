import { LegalPage } from "@/components/legal-page";
export const metadata = { title: "Penggunaan Wajar — jadwalin.id" };

export default function Page() {
  return (
    <LegalPage title="Kebijakan Penggunaan Wajar">
      <p>Agar layanan tetap adil dan stabil, ada batas pemakaian. Batas dapat berubah; yang berlaku saat ini:</p>
      <ul>
        <li>Maksimal 5 workspace per akun; pengiriman undangan dan email dibatasi per hari per penerima.</li>
        <li>Pemesanan publik dibatasi per jaringan, per email, dan per workspace per hari.</li>
        <li>Komentar tiket dan unggahan berkas klien dibatasi per jam; ukuran dan tipe berkas dibatasi (tanpa HTML/SVG).</li>
        <li>Dilarang memakai layanan untuk spam, pengambilan data massal otomatis, atau percobaan menembus keamanan.</li>
      </ul>
      <p>Pemakaian yang terus melampaui batas wajar dapat dibatasi atau ditangguhkan setelah pemberitahuan. Butuh batas lebih besar? Hubungi kami.</p>
    </LegalPage>
  );
}
