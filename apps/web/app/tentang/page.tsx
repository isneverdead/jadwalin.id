import { LegalPage } from "@/components/legal-page";
export const metadata = { title: "Identitas Usaha — jadwalin.id" };

export default function Page() {
  return (
    <LegalPage title="Identitas Usaha">
      <p>Layanan jadwalin.id dikelola oleh:</p>
      <ul>
        <li><strong>Penyelenggara:</strong> [NAMA PENYELENGGARA / BADAN USAHA — ISI SEBELUM LAUNCH]</li>
        <li><strong>Bentuk usaha dan NIB:</strong> [ISI SEBELUM LAUNCH]</li>
        <li><strong>Alamat:</strong> [ISI SEBELUM LAUNCH]</li>
        <li><strong>Email kontak dan pelindungan data:</strong> [ISI SEBELUM LAUNCH]</li>
      </ul>
      <p><small>Catatan operator: halaman ini sengaja berisi placeholder. Jangan diluncurkan sebelum diisi data usaha yang sebenarnya.</small></p>
    </LegalPage>
  );
}
