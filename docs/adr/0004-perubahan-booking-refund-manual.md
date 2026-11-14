# ADR 0004: Perubahan booking oleh pelanggan, refund manual bertanda bukti, dan pelanggan tanpa email

Status: diterima (tambahan atas ADR 0002). Tanggal: 2026-11-15.

## Konteks
- Pelanggan Indonesia umumnya memakai nomor WhatsApp, bukan email. Belum ada WhatsApp resmi (BSP); aturan #4 melarang jalur tidak resmi.
- Pembatalan booking yang DP-nya sudah dibayar sebelumnya langsung berlaku tanpa mengurus uangnya (tidak ada persetujuan, status refund, atau bukti pengembalian).
- Ubah jadwal langsung berlaku tanpa persetujuan penyedia jasa dan tanpa batas waktu.
- Tautan kelola booking (token) hanya ada di email; tamu yang kehilangannya kehilangan akses.

## Keputusan
1. **Tamu tanpa email.** Nomor HP wajib, email opsional. Catatan klien tamu tanpa email diidentifikasi lewat nomor HP (indeks unik parsial `workspace_clients_guest_phone`). Pembatas laju memakai nomor bila email kosong. Kabar untuk pelanggan tanpa email = halaman booking (token) + pesan WhatsApp yang dikirim MANUSIA lewat tautan `wa.me` (bukan API, tidak otomatis), sehingga aturan #4 tidak dilanggar.
2. **Tabel `booking_requests`** (tenant, RLS, append-only secara praktik: status berpindah maju): satu permintaan aktif per booking (`requested`/`approved`, indeks unik parsial). Jenis `cancel` dan `reschedule`. Pelanggan (klien terdaftar maupun tamu) TIDAK menyentuh tabel ini langsung (`client_denied`, `public_denied`); semua lewat fungsi core + `asWorker`. Staf membaca/memutuskan lewat `withWorkspace`.
3. **Pembatalan dengan DP terbayar** wajib disetujui penyedia: `requested → approved (nominal refund 0..DP) → completed` setelah penyedia mengunggah BUKTI transfer refund. Booking baru batal (slot dilepas) saat `completed`. Nominal 0 = batal langsung tanpa refund. Pembayaran berpindah lewat state machine (`paid → refunded|partially_refunded`) dan menulis `payment_events`. Pembatalan tanpa DP terbayar tetap langsung dan kini membatalkan tagihan DP yang masih terbuka (`cancelOpenManualPayment`). jadwalin tetap TIDAK memegang uang: refund ditransfer penyedia sendiri.
4. **Bukti refund** memakai modul berkas core (`createPendingFile`/`finalizeFile`/`signDownload`), terikat ke permintaan (`refund_file_id`; mengunggah ulang menggantikan). Pelanggan mengunduh lewat URL bertanda tangan berumur pendek, hanya setelah `completed`. Pelanggan dapat mengonfirmasi `received`/`not_received`; yang terakhir memberi tahu penyedia.
5. **Ubah jadwal**: pengaturan per usaha `reschedule_mode` (`auto` seperti semula | `approval`) dan `change_min_hours` (0 = tanpa batas; berlaku untuk ubah dan batal sendiri oleh pelanggan). Mode `approval`: pelanggan mengirim permintaan; jadwal lama ditahan; persetujuan memeriksa ulang slot lalu memindahkan.
6. **Pemulihan tautan**: kode booking + nomor HP (+ slug usaha) memutar token kelola (tautan lama berhenti berlaku) dan mengembalikan token baru. Dibatasi laju per IP dan per nomor, Turnstile bila dikonfigurasi, pesan gagal selalu sama. Tidak ada token mentah yang disimpan.
7. **Hak role worker** (dilebarkan secukupnya): CRUD terbatas `booking_requests` (policy `worker_booking_requests`) dan `UPDATE (cancel_token_hash)` pada `bookings` (policy baris `worker_bookings_rotate_token`, migrasi 0037, karena booking yang sudah dibatalkan/direfund pun perlu bisa dipulihkan). Karena policy baris longgar, aturan lama "worker hanya mengonfirmasi/membatalkan booking `pending`" ditegakkan oleh trigger `bookings_worker_status_guard`, sehingga hak status role worker TIDAK melebar (diuji dengan SQL mentah). `workspaces.reschedule_mode`/`change_min_hours` terbaca lewat `SELECT` tabel yang sudah ada. Tidak ada hak lain.

8. **Kontak WhatsApp dua arah tanpa API.** Penyedia memilih nomor yang tampil (`workspaces.contact_phone`, dinormalisasi 62xxx; pilihan dari nomor profil anggota tim atau nomor lain). Pelanggan mendapat tombol samar "Hubungi langsung" di halaman booking: tautan `wa.me` berisi konteks (status booking, pembayaran, pengajuan) dan tautan booking-nya; ia sendiri yang menekan Kirim. Penyedia punya pintasan "Kirim tautan lewat WhatsApp" (Tiket, Pembayaran): `bookingWhatsAppLink` hanya menyusun alamat `wa.me` ke nomor pelanggan berisi ringkasan booking dan tautan pemulihan (`/booking/cari?u=&kode=`; pelanggan memasukkan nomor HP-nya). Tanpa panggilan server, tanpa memutar token, tanpa mengirim apa pun; penyedia sendiri yang menekan Kirim. Nomor usaha WAJIB (saat membuat usaha dan di Pengaturan; usaha lama tanpa nomor mendapat banner). Tombol "Hubungi langsung" pelanggan menyertakan tautan booking-nya atas pilihan pelanggan itu sendiri.

## Konsekuensi
- Email ke pelanggan dari alur persetujuan memuat tautan non-rahasia `/booking/cari?u=<slug>&kode=<kode>`; pelanggan memasukkan nomor HP untuk membuka booking (karena token mentah tidak tersimpan).
- Memulihkan tautan menggugurkan tautan lama di email.
- Pengingat otomatis hanya lewat email; pelanggan tanpa email tidak menerimanya sampai WhatsApp resmi tersedia (kanal `whatsapp` sudah ada di outbox).
- Dialog konfirmasi (`ConfirmButton`) kini dialog di dalam halaman, bukan `window.confirm` (tes E2E diperbarui).
- Tes: `packages/core/test/booking-changes.test.ts` (alur lengkap, penolakan, batas waktu, laju, RLS lintas-aktor).
