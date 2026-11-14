import { LegalPage } from "@/components/legal-page";
export const metadata = { title: "Syarat Layanan — jadwalin.id" };

export default function Page() {
  return (
    <LegalPage title="Syarat Layanan">
      <h2>1. Tentang layanan</h2>
      <p>jadwalin.id adalah perangkat lunak penjadwalan, tiket, dan berkas untuk penyedia jasa. Kami menyediakan alat; hubungan layanan dan pembayaran antara penyedia jasa dan kliennya adalah tanggung jawab mereka.</p>
      <h2>2. Akun</h2>
      <p>Anda wajib memberi data yang benar, menjaga kerahasiaan kata sandi, dan bertanggung jawab atas aktivitas akun. Email harus terverifikasi untuk memakai fitur inti.</p>
      <h2>3. Peran kami</h2>
      <p>Untuk akun dan data penggunaan Anda sendiri, jadwalin.id bertindak sebagai pengendali data. Untuk data klien yang dimasukkan penyedia jasa ke halaman jadwalnya, jadwalin.id bertindak sebagai pemroses data atas nama penyedia jasa (lihat <a href="/dpa">Perjanjian Pemrosesan Data</a>).</p>
      <h2>4. Penggunaan yang dilarang</h2>
      <p>Dilarang menyalahgunakan layanan untuk spam, penipuan, konten melanggar hukum, mengunggah malware, atau mengganggu keamanan dan ketersediaan layanan. Kami dapat menangguhkan akun yang melanggar. Lihat juga <a href="/penggunaan-wajar">Penggunaan Wajar</a>.</p>
      <h2>5. Uang pihak ketiga</h2>
      <p>jadwalin.id tidak memproses, menerima, atau menampung pembayaran. Penyedia jasa menentukan sendiri metode pembayarannya (mis. transfer bank atau QRIS miliknya); pelanggan membayar langsung kepada penyedia jasa dan dapat mengunggah bukti sebagai catatan. Keaslian dan penerimaan pembayaran diverifikasi oleh penyedia jasa; jadwalin.id tidak menjamin keaslian bukti pembayaran. Pendapatan jadwalin.id hanya berasal dari biaya langganan.</p>
      <h2>6. Ketersediaan dan batas tanggung jawab</h2>
      <p>Kami berupaya menjaga layanan tetap tersedia tetapi tidak menjamin bebas gangguan. Sejauh diizinkan hukum, tanggung jawab kami dibatasi pada biaya yang Anda bayar dalam 3 bulan terakhir.</p>
      <h2>7. Penghentian</h2>
      <p>Anda dapat berhenti kapan saja dan meminta penghapusan akun lewat halaman <a href="/akun">Akun</a>. Kami dapat mengubah syarat ini; perubahan material diberitahukan lewat email.</p>
      <h2>8. Hukum yang berlaku</h2>
      <p>Hukum Republik Indonesia.</p>
    </LegalPage>
  );
}
