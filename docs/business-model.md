# Model bisnis jadwalin.id dan paket pengajuan Midtrans (USULAN, 2026-11-15)

Status: usulan untuk diputuskan pemilik. Angka biaya Midtrans adalah kisaran dari ingatan, WAJIB dikonfirmasi di dasbor/kontrak Midtrans sebelum dipakai sebagai janji.

## 1. Model bisnis dalam satu kalimat
Jadwalin.id menjual **perangkat lunak penjadwalan sebagai langganan** (SaaS) plus **jasa penyiapan (onboarding) sekali bayar** kepada bisnis jasa Indonesia. Uang DP pelanggan penyedia jasa TIDAK lewat jadwalin (ADR 0002); jadwalin hanya menerima uang miliknya sendiri: biaya setup dan langganan.

## 2. Siapa membayar apa
| Pihak | Membayar | Kepada | Lewat |
|---|---|---|---|
| Penyedia jasa (salon, studio, lapangan, klinik, perorangan) | Setup sekali + langganan bulanan/tahunan | jadwalin.id | Midtrans (rencana), transfer manual (berjalan sekarang, ADR 0005) |
| Pelanggan penyedia jasa | DP / pelunasan | Penyedia jasa langsung | QRIS/rekening milik penyedia, bukti diunggah, diverifikasi manual |

Konsekuensi: Midtrans hanya dipakai untuk **pendapatan jadwalin sendiri**. Ini sesuai aturan #3 (tidak menampung uang pihak ketiga) dan tidak mengubah ADR 0002. Tidak perlu split/sub-account.

## 3. Harga (satu versi saja)
Ada dua versi harga di repo yang saling bertentangan:
- Landing/brosur (sudah tercetak): setup + bulanan per segmen.
- `docs/pricing.md`: Gratis/Pro/Bisnis tanpa setup.

**Rekomendasi: pakai versi landing/brosur** (sudah dijanjikan ke calon klien), dan jadikan paket "Gratis" sebagai masa uji tanpa penagihan (bukan produk yang dijual).

| Paket | Setup (promo s.d. 31 Des 2026, 10 bisnis pertama) | Normal | Bulanan |
|---|---|---|---|
| Studio | Rp1.000.000 | Rp2.000.000 | Rp250.000 |
| Lapangan & Kelas | Rp1.500.000 | Rp3.000.000 | Rp400.000 |
| Klinik | Rp2.500.000 | Rp5.000.000 | Rp600.000 |
| Perorangan | tanpa setup | | Rp49.000/bln atau Rp399.000/thn |

Garansi 30 hari tanpa kontrak. Kebijakan refund harus mengikuti halaman `/refund`.

## 4. Hitungan kasar (bukan ramalan)
- 10 klien promo, rata-rata setup Rp1,5 jt + Rp400 rb/bln: **Rp15 jt sekali + Rp4 jt/bulan**.
- Biaya tetap yang diketahui: server 2 GB (satu mesin), domain, email Brevo. WhatsApp resmi menambah biaya per percakapan; belum dihitung.
- Biaya Midtrans per transaksi (kisaran, konfirmasi): QRIS sekitar 0,7%, VA sekitar Rp4.000 per transaksi. Untuk tagihan Rp250-600 rb ini kecil; bisa dibebankan ke pelanggan atau diserap.
- Target: klien berbayar pertama sebelum 31 Des 2026 (catatan arah bisnis 12 Nov).

## 5. Pengajuan Midtrans hari ini
Tujuan: akun produksi untuk menerima **pembayaran langganan dan onboarding ke jadwalin.id**.

### Yang SUDAH ada
- Situs aktif https://jadwalin.id: landing, harga, kontak WhatsApp, halaman Syarat, Privasi, Refund, DPA, Penggunaan wajar, Identitas usaha (draf hukum, bukan hasil tinjauan hukum).
- Akun Midtrans baru: Merchant ID M171271403 (akun lama M646808953 milik spendae.com, jangan dicampur).
- Draf email dan balasan: `docs/midtrans/` (balasan-dina.md, email-penambahan-aplikasi.md).

### Yang HARUS dilakukan pemilik (tidak bisa diwakilkan)
1. Login Midtrans, isi data bisnis dan unggah dokumen sebagai **perorangan**: KTP, NPWP pribadi, rekening atas nama sendiri, foto selfie bila diminta. Jangan mengaku berbadan hukum atau ber-NIB.
2. Pilih channel: QRIS, Virtual Account, e-wallet.
3. Isi deskripsi: "Langganan perangkat lunak penjadwalan (SaaS) dan jasa onboarding; DP pelanggan penyedia jasa tidak diproses jadwalin dan tidak lewat Midtrans."
4. Volume: tulis "belum dapat diperkirakan"; jangan mengarang angka.

### Kekurangan di situs yang biasanya ditanyakan reviewer
- Pendaftaran SAAT INI DITUTUP (SIGNUP_CLOSED=true). Reviewer yang mencoba daftar akan buntu. Beri tahu mereka lewat catatan pengajuan atau buka sementara dengan daftar-tunggu/kode undangan.
- Alur bayar langganan di aplikasi belum ada: saat ini tagihan upgrade lewat transfer manual (ADR 0005). Adapter Midtrans (Snap, notifikasi, refund) ada tetapi nonaktif (ADR 0001). Untuk mulai: aktifkan di sandbox, tulis ADR baru (menggantikan sebagian ADR 0005), tes webhook ganda/telat sebelum produksi.
- Tampilkan di halaman harga: nama pemilik/usaha, alamat atau kota, email, nomor WhatsApp. Midtrans biasanya meminta ini.

## 6. Urutan kerja yang disarankan
1. Hari ini: pemilik mengajukan akun Midtrans (butir bagian 5), kami menyiapkan teks dan merapikan halaman harga/kontak.
2. Minggu ini: ADR pembayaran langganan lewat Midtrans, aktifkan adapter di sandbox untuk tagihan paket, tes webhook (sesuai aturan #10).
3. Setelah akun disetujui: kunci produksi di env server, promosi manual, tagihan pertama.
4. Paralel: satu klien nyata (Sans eyelash) menyelesaikan alur booking + DP manual sebagai bukti produk berjalan.

## 7. Keputusan yang perlu dari pemilik
1. Pakai harga landing/brosur (rekomendasi) atau Gratis/Pro/Bisnis?
2. Biaya Midtrans diserap atau dibebankan?
3. Buka kembali pendaftaran untuk reviewer, atau beri akses demo terpisah?
4. Kapan menaikkan PT Perorangan (membuka limit dan kredibilitas Midtrans/WhatsApp BSP)?
