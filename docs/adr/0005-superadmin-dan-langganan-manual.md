# ADR 0005: Superadmin platform dan langganan paket lewat transfer manual

Status: diterima (arah pemilik). Tanggal: 2026-11-15. Menyentuh hak role worker dan aturan #12 (batas paket).

## Konteks
Pemilik platform perlu satu tempat untuk melihat pendaftar baru, memverifikasi upgrade paket, dan mengelola pengguna. Belum ada payment gateway untuk langganan; sementara memakai transfer bank manual ke rekening pemilik (hard-coded). jadwalin tetap tidak memegang uang pelanggan (aturan #3): ini pembayaran langganan ke pemilik platform.

## Keputusan
1. **Superadmin = allowlist env.** `SUPERADMIN_EMAILS` (dipisah koma). `withSuperadmin` (core) mengizinkan hanya akun yang ADA, berEmail TERVERIFIKASI, TIDAK ditangguhkan, dan emailnya ada di daftar (tak peka kapital). Selain itu dijawab `not_found` (halaman /admin 404, keberadaannya tidak dibuka). Daftar kosong = tidak ada superadmin. Otorisasi selalu di core; lapisan web hanya menyembunyikan tautan.
2. **Paket.** `workspaces.plan` (`gratis|pro|bisnis`) dan `plan_until`. Harga dari `PLANS` (docs/pricing.md: Pro 79.000, Bisnis 199.000, tahunan 10x). Batas fitur per paket BELUM ditegakkan di kode (entitlements masih bawaan); itu pekerjaan lanjutan.
3. **Tagihan upgrade** `subscription_invoices` (tenant, RLS): pemilik (hanya `owner`) membuat tagihan (nominal dari daftar harga, bukan input), mengunggah bukti (modul berkas core), superadmin menyetujui/menolak. Satu tagihan terbuka per usaha. Role aplikasi hanya `SELECT`; penulisan lewat worker (status tidak bisa diubah usaha sendiri). Perubahan status tagihan ini bukan pembayaran pelanggan sehingga tidak lewat state machine #10; tiap perubahan dicatat di audit_log.
4. **Hak role worker (dilebarkan secukupnya):** CRUD terbatas `subscription_invoices`; `UPDATE (plan, plan_until)` pada `workspaces`; `UPDATE (suspended_at)` pada `users`. Role aplikasi DICABUT hak `UPDATE` tingkat tabel pada `workspaces` dan diberi hak per kolom tanpa `plan`/`plan_until`, sehingga pemilik tidak bisa mengubah paketnya sendiri walau lewat SQL (diuji).
5. **Penangguhan akun** (`users.suspended_at`): dicek tiap permintaan di lapisan web (sesi dianggap tidak ada; pesan jelas di halaman masuk). Superadmin tidak bisa menangguhkan dirinya atau superadmin lain.
6. **Audit tingkat platform:** tindakan superadmin ditulis ke `audit_log` dengan `workspace_id` NULL (satu-satunya bentuk yang diizinkan policy worker, append-only); usaha sasaran ada di `diff.workspaceId`. Karena itu tindakan superadmin tidak muncul di Log audit usaha.
7. **Rekening dan WhatsApp pemilik** hard-coded di `packages/core/src/platform.ts` (`PLATFORM_BANK`, `PLATFORM_WHATSAPP`). Pintasan WhatsApp = tautan `wa.me` (bukan API): pemilik usaha mengirim bukti dan konteks (usaha, paket, nominal, kode tagihan, status) ke WhatsApp pemilik platform; superadmin mengabari pemilik usaha dan menyapa pendaftar dengan cara yang sama.

## Konsekuensi
- Bukti transfer langganan berisi data finansial pengguna: hanya superadmin (URL bertanda tangan berumur pendek, tercatat) dan pemilik tagihan yang bisa membukanya.
- Pindah ke gateway/rekening lain nanti = ganti sumber konstanta dan tambah adapter; model tagihan tetap.
- Tes: `packages/core/test/platform.test.ts`.
