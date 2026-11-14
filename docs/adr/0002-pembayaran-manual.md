# ADR 0002 — Pembayaran manual oleh penyedia jasa (menggantikan gateway)

Status: **Diterima oleh pemilik** (2026-11-08). Menggantikan arah ADR 0001 (gateway Midtrans). Menyentuh aturan #3, #10, #12 dan hak role worker.

## Keputusan pemilik
jadwalin.id **tidak memproses pembayaran**. Penyedia jasa mengatur sendiri metode pembayaran yang ia terima (QRIS statis, rekening bank, e-wallet, lainnya). Pelanggan membayar langsung ke penyedia jasa di luar sistem, lalu mengonfirmasi dengan mengunggah bukti. Penyedia jasa memverifikasi dan mengonfirmasi secara manual.

## Konsekuensi desain
1. **Aturan #3 terpenuhi secara struktural**: tidak ada dana yang melewati jadwalin, tidak ada gateway, tidak ada sub-account, tidak ada fee transaksi. Pendapatan hanya dari langganan paket (docs/pricing.md: baris fee platform dihapus).
2. **Aturan #10 tetap berlaku**: status pembayaran hanya berubah lewat state machine dan menulis `payment_events` (append-only). Status baru `awaiting_verification` (bukti sudah dikirim). Transisi: `pending → awaiting_verification → paid | pending (ditolak, boleh unggah ulang)`; staf juga boleh `pending → paid` langsung (mis. tunai). Refund = pencatatan manual oleh staf (`ManualProvider.refund` selalu ok; staf mentransfer sendiri di luar sistem).
3. **Tabel baru**: `payment_methods` (per workspace; nomor rekening/QRIS yang memang ditampilkan ke pelanggan) dan `payment_proofs` (bukti per pembayaran, berkas lewat modul berkas core). `payments` dipakai ulang dengan `provider = 'manual'`; `payment_accounts`/`webhook_inbox` dan adapter Midtrans/fake tidak dipakai untuk alur ini (kode dipertahankan nonaktif; tidak dihapus agar bisa dipakai bila arah berubah).
4. **Akses**:
   - Metode bayar: staf admin ke atas mengelola; pelanggan hanya membaca bila punya booking di workspace itu (RLS `bookings` di subquery) — nomor rekening tidak terbuka ke pengunjung acak.
   - Bukti: pelanggan (tamu lewat token booking, atau klien terdaftar) mengunggah lewat alur berkas core (presigned URL); penulisan oleh role worker lewat `asWorker` setelah token/booking divalidasi. Worker mendapat INSERT sempit pada `files` (hanya `uploaded_by IS NULL`) dan INSERT/UPDATE pada `payment_proofs`.
   - Bukti berisi data sensitif pelanggan: hanya staf workspace yang dapat mengunduh (URL bertanda tangan berumur pendek); berkas dihapus 90 hari setelah pembayaran final (runbook).
5. **Penahanan slot**: booking berDP ditahan `pending` selama jendela bayar (3 jam, konstanta `MANUAL_HOLD_MIN`); kedaluwarsa melepas slot. Saat bukti dikirim (`awaiting_verification`) slot tetap ditahan sampai staf memutuskan; ditolak → jendela diperpanjang 60 menit.
6. **Risiko yang diterima**: bukti transfer dapat dipalsukan; verifikasi (mencocokkan mutasi rekening) adalah tanggung jawab penyedia jasa, dan jadwalin tidak menjamin keaslian pembayaran. Syarat Layanan dan Kebijakan Refund diperbarui: transaksi antara pelanggan dan penyedia jasa; jadwalin hanya menyediakan alat pencatatan.
