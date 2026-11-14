# ADR 0003: Sewa barang (rental) di atas penjadwalan inti

Status: diterima (2026-11-09). Berlaku untuk MVP sewa per hari.

## Konteks
Pemilik rental (mobil, motor, kamera, alat pesta, camping) butuh katalog produk dan pemesanan per RENTANG tanggal, bukan janji temu. Penjadwalan yang ada (`bookings`) bersifat per anggota/host, sehingga satu motor tidak bisa direpresentasikan tanpa membuat semua produk saling memblokir. Aturan #2 melarang modul membuat kalender sendiri; aturan #8 mewajibkan anti-bentrok di database.

## Keputusan
1. **Inti (core)**: tabel `resources` (barang/ruang dengan `units` unit identik) dan `reservations` (satu unit, rentang `during`, status). Anti-bentrok = exclusion constraint `reservations_no_overlap` pada (resource, unit, during) untuk status yang menahan unit (`pending`, `confirmed`, `active`). Kode (`reserveUnit`) hanya memilih unit bebas terkecil dan menerjemahkan galat. Primitif ada di `packages/core/src/resources.ts`.
2. **Modul `rental`** (`packages/modules/rental`): `rental_products` (katalog: nama, kategori, deskripsi, harga per hari, uang jaminan, foto) dan `rental_orders` (total, hari, tanggal). Modul memakai primitif inti, tidak membuat kalender sendiri, dan tidak mengimpor modul lain.
3. **Fitur `sewa`** (toggle per halaman jadwal, bawaan MATI agar halaman lama tidak berubah; template rental menyalakannya). Penegakan di server (`requireFeature`). Mematikan `sewa` ditolak selama ada pesanan yang menahan unit.
4. **Tanggal**: hari pertama dan terakhir sewa (keduanya termasuk) di zona halaman; rentang = [00:00 hari pertama, 00:00 hari setelah hari terakhir). Maksimal 90 hari per pesanan.
5. **Uang**: jadwalin.id TIDAK memproses uang (ADR 0002). Total adalah perkiraan; pembayaran dan jaminan diselesaikan langsung antara pemilik dan penyewa. Bukti bayar untuk pesanan sewa belum ada (tindak lanjut: menggeneralisasi pembayaran manual dari subjek `booking` ke `reservation`).
6. **Keamanan (RLS, migrasi 0030–0031)**: keempat tabel tenant tertutup bagi klien portal (`client_denied`). Tamu: membaca katalog aktif dan reservasi aktif (untuk ketersediaan; token tersimpan sebagai hash), membuat reservasi hanya berstatus `pending`, membaca/membatalkan HANYA miliknya lewat token (`app.booking_token_hash`), tanpa menulis produk. Foto produk dibaca tamu lewat policy `public_files_read` yang terbatas pada berkas produk aktif. Endpoint publik: honeypot + Turnstile + pembatas laju DB per IP/email/halaman.
7. **Foto produk** memakai jalur unggah sendiri (`requestProductImageUpload`: hanya gambar ≤ 5 MB, tidak bergantung pada fitur Berkas) di atas modul berkas core.

## Konsekuensi
- Template baru (grup "Rental barang") dengan produk contoh yang bisa disunting saat membuat halaman.
- Menu "Produk sewa" dan "Pesanan sewa" muncul bila fitur `sewa` menyala.
- Slug cadangan baru: `sewa`, `foto`, `produk`.
- CSP: `upgrade-insecure-requests` hanya bila situs HTTPS (agar penyimpanan http lokal tetap bisa dipakai di build produksi lokal/E2E).


## Addendum (DP sewa, fitur jadwal, hapus usaha)
- **DP**: `rental_products.dp_percent` (0–100) dan `rental_orders.dp_idr` (snapshot). Pesanan ber-DP menahan unit (`pending`) bersama tagihan manual (`payments.subject_type = 'reservation'`); unit dilepas otomatis bila DP tidak dibayar dalam 3 jam (rekonsiliasi pembayaran). DP terverifikasi mengonfirmasi pesanan. Jaminan tetap informasi (dikembalikan saat barang kembali, di luar sistem).
- **Hak worker (migrasi 0033)**: `SELECT (id, workspace_id, resource_id, client_id, status, during)` dan `UPDATE (status)` pada `reservations` (policy: hanya dari `pending` ke `confirmed|cancelled`), `SELECT (id, workspace_id, name)` pada `resources` untuk email. Pembaca publik membaca tagihan/metode bayar hanya lewat token reservasi.
- **Fitur `jadwal`**: janji temu per jam menjadi fitur yang dapat dimatikan; usaha sewa-saja tidak lagi memuat menu/halaman jam kerja. Minimal satu dari `jadwal`/`sewa` aktif.
- **Hapus usaha**: soft delete oleh pemilik (konfirmasi ketik nama); data pembayaran/audit dipertahankan.
