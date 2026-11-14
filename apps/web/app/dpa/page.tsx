import { LegalPage } from "@/components/legal-page";
export const metadata = { title: "Perjanjian Pemrosesan Data — jadwalin.id" };

export default function Page() {
  return (
    <LegalPage title="Perjanjian Pemrosesan Data">
      <p>Berlaku antara penyedia jasa pemilik halaman jadwal (<strong>Pengendali</strong>) dan jadwalin.id (<strong>Pemroses</strong>) untuk data pribadi klien yang dimasukkan atau terkumpul lewat halaman usaha.</p>
      <ol>
        <li><strong>Ruang lingkup:</strong> data klien (nama, kontak, booking, tiket, lampiran) hanya diproses untuk menyediakan layanan sesuai instruksi Pengendali.</li>
        <li><strong>Kerahasiaan:</strong> personel kami yang mengakses data terikat kerahasiaan; akses dukungan dibatasi dan tercatat.</li>
        <li><strong>Keamanan:</strong> isolasi per halaman jadwal di basis data (RLS), enkripsi saat transit, cadangan terenkripsi, kontrol akses berbasis peran, log audit.</li>
        <li><strong>Sub-pemroses:</strong> penyedia hosting/basis data, penyimpanan berkas, pengiriman email, Cloudflare. Daftar terkini tersedia atas permintaan; kami memberi tahu bila ada perubahan.</li>
        <li><strong>Hak subjek data:</strong> kami membantu Pengendali menanggapi permintaan akses, perbaikan, dan penghapusan dari subjek data.</li>
        <li><strong>Insiden:</strong> kami memberi tahu Pengendali tanpa penundaan yang tidak wajar setelah mengetahui kegagalan pelindungan data pribadi.</li>
        <li><strong>Berakhirnya layanan:</strong> atas permintaan, data diekspor lalu dihapus; salinan cadangan terhapus bergulir.</li>
        <li><strong>Tanggung jawab Pengendali:</strong> memiliki dasar pemrosesan yang sah (mis. persetujuan) atas data yang dimasukkan dan memberi tahu kliennya.</li>
      </ol>
    </LegalPage>
  );
}
