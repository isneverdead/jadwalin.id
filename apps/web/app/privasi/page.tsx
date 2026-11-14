import { LegalPage } from "@/components/legal-page";
export const metadata = { title: "Kebijakan Privasi — jadwalin.id" };

export default function Page() {
  return (
    <LegalPage title="Kebijakan Privasi">
      <p>Kebijakan ini menjelaskan data pribadi yang kami proses sesuai UU No. 27/2022 tentang Pelindungan Data Pribadi (UU PDP) dan peraturan turunannya.</p>
      <h2>Data yang kami proses</h2>
      <ul>
        <li><strong>Akun:</strong> nama, email, nomor HP (opsional), kata sandi (disimpan sebagai hash), waktu persetujuan.</li>
        <li><strong>Booking dan tiket:</strong> nama, email, nomor HP, topik, catatan, isi tiket, dan lampiran yang Anda kirim.</li>
        <li><strong>Bukti pembayaran:</strong> berkas yang Anda unggah (gambar/PDF) dan catatan Anda; hanya dapat dilihat staf penyedia jasa tempat Anda memesan. Bukti dapat memuat nama dan nomor rekening Anda; sensor data yang tidak perlu sebelum mengunggah.</li>
        <li><strong>Teknis:</strong> alamat IP (untuk batas laju dan keamanan, disimpan dalam bentuk hash), log audit, laporan galat tanpa isi pribadi.</li>
      </ul>
      <h2>Tujuan dan dasar</h2>
      <p>Menjalankan layanan penjadwalan dan tiket (pelaksanaan perjanjian), mengirim konfirmasi dan pengingat, menjaga keamanan dan mencegah penyalahgunaan (kepentingan yang sah), serta memenuhi kewajiban hukum. Untuk tamu tanpa akun, dasarnya adalah persetujuan yang Anda nyatakan di formulir booking.</p>
      <h2>Siapa yang melihat data Anda</h2>
      <p>Penyedia jasa yang Anda pesan, dan staf mereka. Data diproses lewat penyedia infrastruktur kami (hosting, penyimpanan berkas, email, Cloudflare untuk keamanan/penghalang bot). Kami tidak menjual data pribadi.</p>
      <h2>Penyimpanan</h2>
      <p>Selama akun/halaman jadwal aktif, dan sesuai permintaan penghapusan. Cadangan terenkripsi dihapus bergilir dalam hingga 6 bulan.</p>
      <h2>Hak Anda</h2>
      <p>Anda berhak mengakses, memperbaiki, mengekspor, menarik persetujuan, dan meminta penghapusan data. Pengguna terdaftar dapat melakukannya di halaman <a href="/akun">Akun</a>; tamu dapat menghubungi kami lewat kontak di <a href="/tentang">Identitas Usaha</a>. Kami menanggapi paling lambat 30 hari.</p>
      <h2>Keamanan dan insiden</h2>
      <p>Isolasi data antar-halaman di tingkat basis data, enkripsi saat transit, cadangan terenkripsi. Bila terjadi kegagalan pelindungan data pribadi, kami memberitahu pihak terdampak dan otoritas sesuai ketentuan.</p>
      <h2>Admin AI dan data sensitif</h2>
      <p>Layanan Admin AI (WhatsApp) belum aktif. Sebelum diaktifkan, kami akan memperbarui kebijakan ini, memberi tahu bahwa balasan berasal dari sistem otomatis, dan melakukan penilaian dampak (DPIA). Jangan mengirim data kesehatan atau data sensitif lain lewat catatan booking kecuali penyedia jasa Anda telah meminta persetujuan khusus.</p>
    </LegalPage>
  );
}
