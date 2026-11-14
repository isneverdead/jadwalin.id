import { LegalPage } from "@/components/legal-page";
export const metadata = { title: "Identitas Usaha — jadwalin.id" };

const CONTACT_EMAIL = "farizakbarshalahhuddin@gmail.com";

export default function Page() {
  return (
    <LegalPage title="Identitas Usaha">
      <p>Layanan jadwalin.id dikelola oleh:</p>
      <ul>
        <li><strong>Penyelenggara:</strong> Fariz Akbar Shalahhuddin, pelaku usaha perorangan</li>
        <li><strong>Bentuk usaha dan NIB:</strong> usaha perorangan, belum berbadan hukum dan belum memiliki NIB</li>
        <li><strong>Alamat:</strong> layanan daring. Alamat korespondensi dapat diminta lewat email di bawah.</li>
        <li><strong>Email kontak dan pelindungan data:</strong> <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></li>
      </ul>
      <p>Pertanyaan, keluhan, permintaan akses atau penghapusan data, dan permintaan refund dapat dikirim ke email tersebut. Kami menanggapi dalam waktu wajar dan paling lambat 30 hari untuk permintaan terkait data pribadi.</p>
    </LegalPage>
  );
}
