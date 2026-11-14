# Rencana harga jadwalin.id (USULAN, menunggu persetujuan pemilik)

> **Diperbarui 2026-11-08 (ADR 0002):** jadwalin.id tidak memproses pembayaran. Penyedia jasa menerima uang langsung dari pelanggannya lewat metode yang ia atur sendiri (QRIS statis, rekening, dll.). **Tidak ada fee transaksi**; pendapatan hanya dari langganan dan onboarding. Baris/bagian fee platform di bawah ini sudah tidak berlaku.

Status: usulan 2026-11-08. Belum berlaku, belum ada penagihan, belum ada di kode (batas paket belum diterapkan di entitlements).
Sumber harga yang ada: PDF promosi (Gratis Rp0, Pro Rp79.000/bln, Bisnis Rp199.000/bln, onboarding Rp499.000 dan Rp1.299.000).
Catatan jujur: angka di bawah BUKAN hasil riset pasar atau perhitungan biaya nyata. Biaya server, penyimpanan bukti, dan WhatsApp BSP belum diketahui. Lihat "Yang harus dikonfirmasi".

## Prinsip
1. Pendapatan hanya dari langganan paket dan onboarding (aturan #3: dana klien tidak pernah ditampung; tidak ada fee transaksi karena jadwalin tidak memproses pembayaran).
2. Fitur inti (halaman booking, tiket, berkas) tersedia di semua paket; paket berbeda pada **batas** fitur, bukan pada keamanan atau ekspor data.
3. Semua batas dibaca dari entitlements di `core` (aturan #12), bukan hard-code di modul.
4. Selama akses awal tidak ada tagihan; harga diumumkan sebelum penagihan dibuka.

## Paket langganan

| | Gratis | Pro | Bisnis |
|---|---|---|---|
| Harga bulanan | Rp0 | Rp79.000 | Rp199.000 |
| Harga tahunan (10× bulanan) | Rp0 | Rp790.000 | Rp1.990.000 |
| Jenis pertemuan | 3 | 15 | 50 |
| Anggota tim (staf/admin) | 2 | 5 | 20 |
| Ukuran berkas maks. | 10 MB | 25 MB | 50 MB |
| Email notifikasi per bulan | 300 | 2.000 | 10.000 |
| Booking dengan DP (metode bayar diatur sendiri) | Ya | Ya | Ya |
| Log audit | 100 terakhir | 1.000 terakhir | Penuh |
| WhatsApp resmi (BSP) | — | Add-on | Termasuk kuota dasar |
| Dukungan | Dokumentasi | Email | Email prioritas |

Pembayaran DP dikelola penyedia jasa sendiri (ADR 0002): metode bayar diatur di menu Pembayaran, pelanggan mengunggah bukti, penyedia jasa memverifikasi. Tidak ada biaya MDR/fee dari jadwalin.

Karena tidak ada fee transaksi, selisih Gratis → Pro/Bisnis hanya batas fitur (jenis pertemuan, anggota, berkas, email, log audit). Pastikan batas Gratis cukup nyata untuk dicoba tetapi cukup sempit untuk mendorong upgrade.

## Onboarding (sekali bayar, terpisah dari langganan)
| Paket | Harga | Isi |
|---|---|---|
| Mandiri | Rp0 | Panduan dan template |
| Terpandu | Rp499.000 | Kami menyiapkan workspace, jam kerja, jenis pertemuan, halaman booking, dan pelatihan singkat |
| Terpandu Plus | Rp1.299.000 | Semua isi Terpandu + tim sampai 5 anggota, beberapa host, alur tiket tertulis, dan penyiapan pembayaran DP |

## Kebijakan
- Perubahan paket berlaku di awal periode berikutnya; naik paket langsung berlaku (prorata).
- Turun paket tidak menghapus data; batas yang terlewati menjadi baca-saja sampai dirapikan.
- Refund langganan: 7 hari pertama (lihat Kebijakan Refund).
- Pajak (PPN) dan perlakuan harga: tentukan bersama konsultan pajak sebelum penagihan; harga di atas belum memperhitungkan PPN.

## Pemetaan ke kode (bila disetujui)
`plans` + `plan_entitlements` (docs/data-model.md §6), kunci entitlements: `max_meeting_types`, `max_members`, `max_file_mb`, `email_per_month`, `audit_log_visible`, `wa_messages_per_month`. `getLimits(workspaceId)` di `packages/core/src/entitlements.ts` membaca langganan aktif; tanpa langganan memakai paket Gratis. Perubahan ini butuh migrasi tabel `subscriptions` dan tes (batas per paket, turun paket, fee dibulatkan ke bawah).

## Yang harus dikonfirmasi sebelum final
1. ~~Tarif dan model Midtrans~~ — tidak relevan lagi (tanpa gateway).
2. **Biaya WhatsApp BSP** per percakapan/pesan, untuk menentukan add-on dan kuota Bisnis.
3. **Biaya tetap per workspace** (server, penyimpanan, email) untuk memastikan Gratis tidak merugi pada pemakaian wajar.
4. **PPN dan badan usaha**: apakah harga sudah termasuk PPN; PT Perorangan belum berdiri.
5. Apakah metode pembayaran manual + DP boleh di paket Gratis (usulan: boleh; biaya penyimpanan bukti kecil) atau hanya Pro ke atas.
