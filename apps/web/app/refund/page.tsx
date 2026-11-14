import { LegalPage } from "@/components/legal-page";
export const metadata = { title: "Kebijakan Refund — jadwalin.id" };

export default function Page() {
  return (
    <LegalPage title="Kebijakan Refund">
      <h2>Langganan jadwalin.id</h2>
      <p>Biaya langganan/onboarding yang telah dibayar dapat dikembalikan penuh dalam 7 hari pertama bila layanan belum dipakai produktif. Setelahnya, pembatalan berlaku untuk periode berikutnya tanpa pengembalian sebagian, kecuali terjadi gangguan layanan berkepanjangan akibat kesalahan kami.</p>
      <h2>Pembayaran klien ke penyedia jasa</h2>
      <p>Pembayaran (DP/biaya) dari klien ke penyedia jasa diatur kebijakan pembatalan penyedia jasa. jadwalin.id tidak menerima atau menampung dana tersebut; pengembalian dana dilakukan langsung oleh penyedia jasa (mis. transfer balik) dan hanya dicatat di sistem. Hubungi penyedia jasa untuk refund DP.</p>
      <h2>Cara mengajukan</h2>
      <p>Hubungi kami lewat kontak di <a href="/tentang">Identitas Usaha</a> dengan menyertakan email akun dan bukti pembayaran.</p>
    </LegalPage>
  );
}
