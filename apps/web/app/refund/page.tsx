import { LegalPage } from "@/components/legal-page";
export const metadata = { title: "Kebijakan Refund — jadwalin.id" };

export default function Page() {
  return (
    <LegalPage title="Kebijakan Refund">
      <h2>Langganan jadwalin.id</h2>
      <p>Biaya langganan/onboarding yang telah dibayar dapat dikembalikan penuh dalam 7 hari pertama bila layanan belum dipakai produktif. Setelahnya, pembatalan berlaku untuk periode berikutnya tanpa pengembalian sebagian, kecuali terjadi gangguan layanan berkepanjangan akibat kesalahan kami.</p>
      <h2>Pembayaran klien ke penyedia jasa</h2>
      <p>Pembayaran (DP/biaya) dari klien ke penyedia jasa diatur kebijakan pembatalan penyedia jasa yang ditampilkan saat memesan. jadwalin.id tidak menampung dana tersebut; pengembalian dana dilakukan lewat gateway pembayaran sesuai kebijakan penyedia jasa. Biaya platform yang diambil dari transaksi yang direfund mengikuti ketentuan gateway.</p>
      <h2>Cara mengajukan</h2>
      <p>Hubungi kami lewat kontak di <a href="/tentang">Identitas Usaha</a> dengan menyertakan email akun dan bukti pembayaran.</p>
    </LegalPage>
  );
}
