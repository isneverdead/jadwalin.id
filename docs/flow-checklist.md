# Daftar periksa menu dan alur jadwalin.id

Tujuan dokumen: satu tempat untuk mengingat (1) **untuk apa** tiap menu/alur ada, (2) **siapa** pemakainya, (3) **apa yang sudah dicek** dan dengan cara apa, (4) **apa yang masih janggal/terbuka**.
Diperbarui: 2026-11-09. Perbarui tiap kali menu/alur diubah; jangan centang tanpa bukti.

Legenda bukti: **TES** = tes otomatis (vitest), **E2E** = Playwright, **SAPU** = sapuan halaman di browser dev (status 200, judul benar, tanpa galat, halaman fitur-mati menampilkan penjelasan), **BACA** = hanya dibaca kodenya/diaudit, belum dijalankan.

## 0. Prinsip produk (acuan untuk menilai "masuk akal")
- Satu usaha = satu **halaman publik** (`jadwalin.id/<slug>`) + satu **dasbor** (`/w/<slug>`).
- Usaha punya **mode** lewat fitur: `jadwal` (janji temu per jam), `sewa` (katalog barang per hari), plus pelengkap `tiket`, `pembayaran` (DP manual), `berkas`. Menu, halaman publik, dan ringkasan harus mengikuti fitur, bukan jenis template.
- jadwalin.id **tidak memproses uang**: DP/pelunasan/jaminan dibayar langsung ke penyedia; sistem hanya mencatat bukti dan verifikasi.
- Satu usaha harus punya minimal satu mode: `jadwal` atau `sewa`.

## 1. Dasbor pemilik (`/w/<slug>`)

| Menu | Tujuan / fungsi | Pemakai | Tampil bila | Bukti | Catatan / celah |
|---|---|---|---|---|---|
| Ringkasan | Satu layar "apa yang perlu saya lihat hari ini": bukti menunggu, tiket aktif, layanan aktif; untuk sewa: pesanan menunggu, diambil hari ini, sedang disewa, produk aktif; tautan publik; anggota tim; undangan | semua anggota | selalu | SAPU, E2E (fitur) | Kartu mengikuti fitur. Checklist "langkah berikutnya" hanya muncul sekali setelah usaha dibuat (belum persisten) |
| Jadwal & layanan | Atur jam kerja mingguan, layanan (durasi, DP, lokasi), pelayan, libur/pengecualian, pratinjau slot | admin/pemilik (staf melihat) | fitur `jadwal` | SAPU, E2E, TES | Banner merah bila layanan ber-DP tetapi belum ada metode bayar aktif. Kolom DP ber-titik ribuan |
| Produk sewa | Katalog barang yang disewakan: nama, kategori, harga/hari, jumlah unit, DP (% dari total), jaminan, foto, deskripsi, aktif/nonaktif | admin/pemilik | fitur `sewa` | SAPU, E2E, TES | Tidak ada hapus produk (hanya nonaktif). Unit tidak bernama/berplat |
| Pesanan sewa | Daftar permintaan sewa: konfirmasi/tolak, tandai diambil, tandai kembali, batalkan; status DP per pesanan | semua anggota | fitur `sewa` | SAPU, E2E, TES | Pesanan ber-DP tidak bisa dikonfirmasi lewat tombol (arahkan ke Pembayaran). Belum ada pesanan manual/walk-in, kalender unit, ubah tanggal |
| Tiket | Percakapan dengan klien terdaftar: status, prioritas, penugasan, lampiran, jadwalkan meeting | semua anggota | fitur `tiket` | SAPU, E2E (tiket), TES | Tamu tanpa akun tidak bisa membuka tiket (butuh akun) |
| Pembayaran | (a) metode bayar penyedia (rekening/QRIS/e-wallet/lainnya), (b) antrean verifikasi bukti untuk **booking jasa dan pesanan sewa**; panduan 3 langkah | admin (metode), semua (verifikasi) | fitur `pembayaran` | SAPU, E2E (booking + sewa), TES | Refund dicatat manual di luar sistem; belum ada kode unik nominal; belum ada pengingat bayar |
| Berkas | Simpan dokumen internal, unduh lewat tautan sementara | semua anggota | fitur `berkas` | SAPU, E2E (tiket) | Tidak terhubung ke pesanan sewa (belum ada unggah KTP/SIM penyewa) |
| Log audit | Riwayat kejadian penting (akun, jadwal, pembayaran, sewa, fitur) | admin/pemilik | selalu | SAPU, BACA | Label Indonesia untuk sewa/fitur/hapus ditambahkan; zona waktu mengikuti usaha; isi perubahan tidak ditampilkan |
| Pengaturan | Nyalakan/matikan fitur (dengan penjaga), info usaha, **hapus usaha** (soft delete, ketik nama) | admin/pemilik (hapus: pemilik) | selalu | SAPU, E2E (fitur, sewa), TES | Mematikan fitur ditolak bila masih dipakai (DP aktif, pembayaran terbuka, booking/pesanan berjalan) |

Menu sidebar: urutan sewa → Pesanan sewa, Produk sewa; jasa → Jadwal & layanan; lalu Tiket, Pembayaran, Berkas, Log audit, Pengaturan. Lencana: pesanan sewa menunggu, tiket aktif, bukti menunggu verifikasi.

## 2. Dasbor akun (`/dashboard`, `/dashboard/bisnis-baru`, `/akun`)

| Halaman | Tujuan | Bukti | Catatan |
|---|---|---|---|
| `/dashboard` | Daftar usaha milik/ikut dikelola + usaha sebagai klien | SAPU, E2E | Kartu belum membedakan jenis usaha atau menampilkan pesanan menunggu per usaha |
| `/dashboard/bisnis-baru` | Pembuatan usaha 4 langkah: pilih bidang (31 template) → nyalakan/matikan fitur → atur layanan+jam **atau** produk → nama+link (pratinjau ponsel). Tombol "Cara pakai" beranimasi di tiap bagian | SAPU, E2E, TES | Langkah 3 mengikuti fitur `jadwal`/`sewa`; DP% produk muncul bila pembayaran menyala |
| `/akun` | Data akun, ekspor data, hapus akun | BACA | Pemilik usaha harus menyerahkan/menghapus usaha lebih dulu |

## 3. Halaman publik & alur pelanggan

| Alur | Tujuan | Bukti | Catatan |
|---|---|---|---|
| `/<slug>` | Etalase: layanan (jasa) dan/atau katalog sewa; kirim pesan (tiket) | SAPU, E2E | Teks hero dan empty state mengikuti mode usaha |
| `/<slug>/<layanan>` | Pilih tanggal/jam, isi data, (DP) lalu pesan; bot dilindungi Turnstile+honeypot+batas laju | SAPU, E2E, TES | Bila DP tapi belum ada metode bayar: peringatan di atas dan tombol nonaktif (`paymentReady`) |
| `/booking/<token>` (+`/ubah`) | Pelanggan jasa melihat/mengubah/membatalkan booking dan membayar DP (metode, 3 langkah, unggah bukti) | E2E, TES | Token hanya hash di DB |
| `/<slug>/produk/<id>` | Pilih rentang tanggal sewa (kalender ketersediaan), total otomatis, DP dan jaminan dijelaskan; HP wajib | E2E, TES | Jam ambil/kembali hanya lewat catatan |
| `/sewa/<token>` | Pelanggan sewa melihat status, membayar DP (metode, langkah, unggah bukti), membatalkan | E2E, TES | Tautan tidak dikirim ulang bila hilang |
| `/jadwal-saya` | Portal klien terdaftar: tiket dan meeting | SAPU, E2E (tiket) | Penyewa sewa belum punya portal |
| Hukum: `/syarat /privasi /refund /dpa /penggunaan-wajar /tentang` | Dokumen legal (DRAF sampai ditinjau hukum) | SAPU | Belum menyebut sewa/data identitas penyewa |

## 4. Alur lintas-menu (alur ujung ke ujung)

| Alur | Langkah | Bukti |
|---|---|---|
| Booking jasa gratis | tamu pilih slot → email konfirmasi + tautan kelola → tiket otomatis → ubah/batal membebaskan slot | E2E booking, TES |
| Booking jasa ber-DP | slot ditahan 3 jam → tamu bayar + unggah bukti → staf verifikasi → terkonfirmasi (atau ditolak 60 mnt unggah ulang; kedaluwarsa melepas slot) | E2E booking, TES |
| Sewa tanpa DP | tamu pilih tanggal → pesanan `menunggu` → pemilik konfirmasi → diambil → selesai/batal | E2E sewa, TES |
| Sewa ber-DP | metode bayar diatur → tamu ajukan (unit ditahan 3 jam) → unggah bukti → pemilik "Konfirmasi lunas" → pesanan terkonfirmasi + email; batal/tolak ikut membatalkan tagihan | E2E sewa (penuh dengan unggah bukti), TES |
| Tiket klien | klien buka tiket → staf tangani → lampiran → meeting → tutup | E2E tiket, TES |
| Kelola fitur | nyalakan/matikan dengan penjaga (DP aktif, pembayaran terbuka, pesanan/booking berjalan, minimal satu mode) | E2E fitur+sewa, TES |
| Hapus usaha | ketik nama → soft delete → hilang dari dasbor/publik/portal; slug bebas dipakai lagi; audit ada | E2E (fitur: nama salah ditolak, hapus, 404 publik+dasbor, link dipakai ulang), TES |
| Isolasi data | RLS per aktor (anggota/klien/tamu/worker), klasifikasi tabel, siklus policy | TES (security-audit, rental, public-booking) |

## 5. Temuan terbuka (urut dampak)
1. Pesanan manual/walk-in oleh pemilik (pesanan via WA tidak terblokir → bisa tersewa ganda).
2. Kalender per unit, nama/plat unit, blokir tanggal servis, ubah tanggal/produk pesanan.
3. Pesanan sewa **tanpa DP** menahan unit tanpa batas waktu (belum ada kedaluwarsa).
4. Jam ambil/kembali (sewa baru per hari); aturan keterlambatan/denda.
5. Unggah KTP/SIM penyewa lewat modul berkas core; kontak WhatsApp usaha di halaman sewa.
6. Email status sewa memakai tautan ke root app, bukan ke pesanan (token tidak disimpan); tidak ada email "diambil/selesai".
7. Pengingat bayar otomatis; kode unik nominal; refund tercatat di sistem.
8. Portal penyewa; kartu usaha di `/dashboard` per jenis + ringkasan.
9. Tinjauan hukum teks legal untuk sewa; menghapus produk sewa; filter kategori katalog.
10. Link booking tamu lama (`/booking/<token>`) belum disembunyikan setelah usaha dihapus.

## 6. Cara memeriksa ulang (urutan baku)
1. `pnpm run ci` (typecheck, depcheck, tes) dan `pnpm e2e`; `node scripts/check-secrets.mjs`.
2. SAPU: server dev, masuk sebagai demo, buka semua rute `/w/<slug>/*` untuk tiga jenis usaha (jasa, sewa, pribadi) dan semua halaman publik; harapannya 200, judul benar, fitur mati menampilkan penjelasan, rute ngawur 404.
3. Untuk perubahan UI: lihat di browser desktop dan lebar HP (375px); periksa luapan horizontal (`scrollWidth > clientWidth`).

## 7. Riwayat pemeriksaan penuh (2026-11-09)
- SAPU 3 jenis usaha x 9 menu + 12 halaman akun/publik/legal + 2 rute ngawur: semua sesuai harapan.
- HP (375px): halaman bisnis-baru, dasbor, Ringkasan, Produk sewa (form), Pesanan sewa, Pembayaran, Jadwal, katalog publik, halaman produk publik: tanpa luapan horizontal halaman. Nav sidebar menggulir ke samping (disengaja).
- Ditemukan dan diperbaiki: tombol "Cara pakai" melebar karena aturan global `button { width: 100% }` sehingga meluap di layar kecil; pesan batas 5 usaha masih menyebut "halaman jadwal" dan kini mengarahkan ke fitur hapus usaha.
- Ditambahkan: E2E "hapus usaha" (akun dan usaha buatan tes sendiri).
- Belum bisa diuji di browser dev karena batas 5 usaha pada akun demo: pembuatan usaha baru lewat UI (sudah dicakup E2E).
