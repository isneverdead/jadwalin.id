# Checklist keamanan M6 (hasil review 2026-11)

Status: ✅ lulus · ⚠️ risiko diterima (didokumentasikan) · ⏳ butuh tindakan operator.

## Autentikasi dan sesi
- ✅ Email+kata sandi (min 10), verifikasi email wajib, kata sandi di-hash (Better Auth), token sekali pakai.
- ✅ Batas laju per IP (DB) dan per email (10/15 menit); jejak audit `auth.*` tanpa email mentah.
- ✅ Origin ketat untuk semua tulis dari browser (tutup login-CSRF).
- ⚠️ Batas per email dapat dipakai mengunci akun korban sementara (15 menit) — diterima; alternatif CAPTCHA saat gagal beruntun dicatat untuk nanti.

## Isolasi tenant
- ✅ RLS ENABLE+FORCE di semua tabel tenant; `security-audit.test.ts` memeriksa otomatis: klasifikasi tiap tabel, policy `tenant_isolation`, role non-super, tanpa SECURITY DEFINER, policy RESTRICTIVE hanya `TO jadwalin_app`, **penjaga siklus policy** (rekursi tak terbatas), matriks lintas-tenant per aktor, append-only untuk audit/riwayat/komentar.
- ✅ Tiga pintu akses: `withWorkspace` (staf), `withClientAccess` (klien), `withPublicWorkspace` (tamu); token disimpan sebagai hash.
- ⚠️ Baca luas yang diterima: booking aktif dan klien tamu dapat terbaca aktor tertentu dalam lingkup workspace (didokumentasikan di data-model).
- ⚠️ `rate_counters`/`rate_limits` bukan tabel tenant (tanpa RLS; kunci ber-hash, tanpa data pribadi).

## Penyalahgunaan dan bot
- ✅ Turnstile server-side (gagal tertutup) + batas laju DB + honeypot di booking publik.
- ✅ Batas global per penerima (alias Gmail/+tag dinormalisasi), undangan, workspace per akun, komentar/unggahan klien, slot per kueri.
- ⚠️ Email tamu belum diverifikasi (tanpa double opt-in); dampak dibatasi batas laju per penerima. Cache slot belum ada.
- ⏳ Kunci origin ke Cloudflare (runbook §6).

## Header dan aplikasi
- ✅ CSP ber-nonce + strict-dynamic, frame-ancestors none, nosniff, HSTS (prod), Referrer-Policy no-referrer + no-store di URL berisi token; E2E mengumpulkan pelanggaran CSP.
- ✅ Berkas: tipe diizinkan eksplisit (tanpa HTML/SVG), unduhan bertanda tangan.
- ✅ `pnpm audit --prod`: tanpa kerentanan; CI memblokir ≥ high. Pemindai rahasia `scripts/check-secrets.mjs`.

## Backup dan pemantauan
- ✅ Backup terenkripsi harian, uji restore otomatis harian (≥ 9 pemeriksaan), retensi, dokumentasi DR di runbook.
- ✅ `/api/health`, `/api/ready`, heartbeat worker, Sentry dengan scrubber (tanpa PII/token/query).
- ⏳ Pasang monitor uptime eksternal, isi `SENTRY_DSN`, bucket+passphrase backup produksi, jalankan backup manual pertama.

## Privasi dan legal (UU PDP)
- ✅ Halaman legal (draf), persetujuan tercatat (`users.terms_version/at`, `workspace_clients.consent_version/at`), ekspor data (`/akun/ekspor`), permintaan hapus (`data_requests`), log audit untuk admin.
- ⏳ Tinjauan hukum atas semua halaman, isi identitas usaha, DPIA (wajib sebelum Admin AI/data kesehatan aktif), daftar sub-pemroses final.

## Kriteria selesai M6
- ✅ Restore teruji otomatis dan terdokumentasi.
- ✅ Checklist kode lulus (item ⏳ adalah tindakan operasional di luar kode).
- ⏳ Dipakai pemilik ≥ 1 minggu.
