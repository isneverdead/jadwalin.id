# ADR 0001 — Gateway pembayaran dan hak role worker untuk pembayaran

Status: **Digantikan oleh ADR 0002 (2026-11-08)** — pemilik memutuskan tidak memproses pembayaran; kode gateway dipertahankan nonaktif. Sebelumnya: Diusulkan. Menyentuh aturan #3, #10, #12 dan melebarkan hak `jadwalin_worker` (wajib ADR).

## Konteks
M7 menambah DP/pembayaran di booking. Aturan #3: jadwalin tidak pernah menampung uang pihak ketiga; hanya fee platform. Pemilik sudah punya akun Midtrans (aplikasi lain) dan sedang menanyakan lewat email apakah aplikasi baru bisa dipasang dan apakah ada model sub-merchant/split. Jawaban belum ada.

## Keputusan
1. **Inti netral-penyedia.** `core/payments` bergantung pada antarmuka `PaymentProvider` (buat transaksi, verifikasi notifikasi, ambil status, refund) dan **tidak** mengenal Midtrans/Xendit. Adapter: `fake` (uji/staging lokal, sepenuhnya deterministik) dan `midtrans` (Snap + notifikasi + Status API + Refund API, mode sandbox dulu).
2. **Dana tidak melewati jadwalin.** Pembayaran hanya dapat dibuat bila workspace punya `payment_accounts` `kyc_status='verified'` untuk penyedia itu (akun/merchant milik penyedia jasa atau sub-account). Penyedia yang tidak mendukung pemisahan dana tidak boleh diaktifkan di produksi untuk workspace lain; adapter menyatakan `settlement: "split" | "own_account"`. **Produksi diblokir sampai jawaban Midtrans (atau penyedia lain) memastikan model yang sesuai aturan #3.** Kunci server penyedia milik pihak ketiga, bila diperlukan, disimpan terenkripsi (amplop, kunci di env) — dirinci saat model dipastikan.
3. **State machine** `created → pending → paid → (refund_pending →) refunded | partially_refunded`; `pending → expired | failed | cancelled`. Setiap transisi menulis `payment_events` (append-only, tanpa UPDATE/DELETE bagi semua role aplikasi) dalam transaksi yang sama. Transisi tak sah ditolak.
4. **Webhook idempoten** lewat `webhook_inbox` (unik `provider + event_id`; id diturunkan dari isi notifikasi bila penyedia tak memberi id). Verifikasi tanda tangan SEBELUM menyimpan. Pemrosesan: duplikat diabaikan; notifikasi terlambat/berurutan terbalik tidak boleh memundurkan status (hanya transisi maju yang sah; sisanya dicatat `ignored`).
5. **Hak worker** diperluas sempit: `payments` (SELECT/INSERT/UPDATE), `payment_events` (SELECT/INSERT), `refunds` (SELECT/INSERT/UPDATE), `payment_accounts` (SELECT), `webhook_inbox` (SELECT/INSERT/UPDATE; bukan tabel tenant), dan `bookings` hanya kolom `status` untuk `pending → confirmed|cancelled`. Alasan: webhook datang tanpa konteks pengguna.
6. **Uang = bigint Rupiah.** Fee platform dihitung dari entitlements (`platform_fee_bps`), dibulatkan ke bawah, disimpan terpisah (`platform_fee_idr`).
7. **Booking dengan DP** menahan slot sebagai `pending` selama jendela bayar (default 30 menit); kedaluwarsa melepas slot (booking `cancelled`). Pembayaran sukses mengonfirmasi booking.

## Konsekuensi
- Ganti penyedia = tulis adapter baru + tes kontrak yang sama; tabel tidak berubah.
- Rekonsiliasi berkala memanggil Status API untuk pembayaran `pending` yang melewati jendela, dan mencatat selisih sebagai `payment_events` bersumber `reconcile`.
