# Runbook jadwalin.id

Dokumen operasional untuk satu operator. Semua perintah dari root repo. Variabel lingkungan: lihat `.env.example`.

## 1. Komponen dan kesehatan
| Komponen | Cek | Tanda sehat |
|---|---|---|
| Web | `GET /api/health` | 200 `{ok:true}` (hanya proses hidup) |
| Kesiapan | `GET /api/ready` | 200; 503 bila db/storage/worker/backup bermasalah (hanya boolean, tanpa detail) |
| Worker | `job_status` + heartbeat | heartbeat ≤ 3 menit |
| Backup | `job_status` (backup ≤ 30 jam, backup_verify ≤ 36 jam) | `ok` |

**Pemantauan eksternal (wajib sebelum launch):** pasang monitor uptime (mis. UptimeRobot/Better Stack) ke `https://<domain>/api/ready` (interval 1–5 menit, notifikasi email/WA). Isi `SENTRY_DSN` (web dan worker) dan `SENTRY_ENVIRONMENT`.

## 2. Backup harian terenkripsi
- Worker menjadwalkan (zona Asia/Jakarta, hanya bila `BACKUP_ENABLED=true`): backup `02:00` harian, **uji restore otomatis** `03:30` harian, pemangkasan retensi Minggu `04:00` (7 harian / 4 mingguan / 6 bulanan).
- Berkas: `pg_dump -Fc` → dienkripsi AES-256-GCM (kunci diturunkan dari `BACKUP_PASSPHRASE` ≥ 32 karakter dengan scrypt) → bucket `BACKUP_S3_*` (**bucket terpisah dari berkas pengguna**, idealnya akun/penyedia berbeda). Setiap backup punya manifest `.json` (hash, jumlah baris, versi migrasi).
- **Passphrase**: simpan di password manager DAN satu salinan offline terpisah. Tanpa passphrase backup tidak dapat dibuka. Jangan simpan di repo atau di bucket yang sama.
- Klien `pg_dump/pg_restore` harus satu versi mayor dengan server (dijaga kode). Set `PG_BIN_DIR` bila klien bawaan beda versi. Dev macOS: `infra/pg16-wrappers`.
- Setelah deploy pertama: jalankan manual sekali dan pastikan `ready` hijau:
  ```bash
  pnpm --filter @jadwalin/worker backup backup
  pnpm --filter @jadwalin/worker backup verify
  pnpm --filter @jadwalin/worker backup list
  ```

## 3. Pemulihan (disaster recovery)
Target: **RPO ≤ 24 jam** (backup harian), **RTO ≤ 4 jam**. Uji restore otomatis membuktikan backup terbaru dapat dipulihkan tiap hari; lakukan latihan manual penuh minimal tiap kuartal.

1. Siapkan Postgres 16 baru (versi mayor sama). Buat database kosong dan role pemilik.
2. Ambil dua hal: `BACKUP_PASSPHRASE` dan akses ke bucket backup.
3. Pilih backup: `pnpm --filter @jadwalin/worker backup list`.
4. Pulihkan ke database baru dengan alat yang sama dengan uji restore (`restoreAndVerify` dipanggil lewat `backup verify` untuk database scratch). Untuk pemulihan produksi: unduh+dekripsi lewat `apps/worker/src/backup/restore.ts` (fungsi dekripsi stream), lalu `pg_restore --no-owner -d <db-baru>`.
5. **Buat role di cluster baru SEBELUM restore** bila belum ada: `jadwalin_app`, `jadwalin_worker` (NOLOGIN, bukan superuser) — migrasi mengatur hak; `ensureRoles` di restore membuatnya otomatis pada DB scratch.
6. Verifikasi: jumlah baris vs manifest, migrasi terakhir, `SELECT count(*) FROM pg_policy`, RLS aktif (`relforcerowsecurity`), uji login + satu booking.
7. Arahkan `DATABASE_URL` aplikasi ke DB baru, jalankan `pnpm --filter @jadwalin/db migrate` (idempoten), start web+worker, pantau `/api/ready`.
8. Catat insiden di log operasi (tanggal, penyebab, durasi, data hilang).

## 4. Permintaan hak data (UU PDP)
Pengguna mengajukan di `/akun`. Permintaan tercatat di `data_requests` (status `pending`). SLA internal: ≤ 30 hari (target 7).
```sql
-- daftar yang menunggu (jalankan sebagai pemilik DB)
SELECT r.id, r.kind, r.created_at, u.email FROM data_requests r JOIN users u ON u.id = r.user_id WHERE r.status = 'pending' ORDER BY r.created_at;
```
Prosedur hapus akun: (1) verifikasi identitas lewat email terdaftar; (2) pastikan pengguna bukan satu-satunya pemilik workspace aktif (serahkan/hapus dulu); (3) anonimkan baris `workspace_clients` miliknya (`name='Dihapus'`, `email=NULL`, `phone=NULL`, `user_id=NULL`); (4) hapus baris `users` (cascade ke sesi/akun/anggota); (5) `UPDATE data_requests SET status='done', handled_at=now()` — baris ini dihapus cascade, jadi catat penyelesaian di log operasi; (6) kirim konfirmasi email. `audit_log` bersifat append-only dan memuat id/hash, bukan data pribadi mentah. Cadangan terenkripsi menua keluar dalam ≤ 6 bulan (disebut di Kebijakan Privasi).

## 5. Insiden keamanan
1. Isolasi: cabut kredensial yang terdampak (rotasi `BETTER_AUTH_SECRET` mengeluarkan semua sesi; ganti kunci S3/SMTP).
2. Evaluasi cakupan lewat `audit_log` (`auth.*`) dan log pino; Sentry memuat galat tanpa data pribadi.
3. Kegagalan pelindungan data pribadi: beri tahu pihak terdampak dan otoritas sesuai UU PDP (target ≤ 3×24 jam sejak diketahui).
4. Tulis post-mortem; tambahkan tes regresi.

## 6. Deploy dan jaringan
- Staging dulu (mode test gateway), produksi lewat promosi manual. Tidak ada deploy langsung.
- Produksi di belakang Cloudflare: `TRUST_PROXY=cloudflare` (IP dari `cf-connecting-ip`). **Kunci origin** agar hanya menerima trafik dari Cloudflare (aturan firewall/Authenticated Origin Pulls); bila tidak, IP dapat dipalsukan dan pembatas laju bisa dilewati.
- Isi `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` (produksi menolak booking tamu tanpa verifikasi).
- Port Postgres/Redis/S3 compose hanya bind `127.0.0.1`; jangan membukanya ke internet.
- `.env` tidak di-commit; CI menjalankan `scripts/check-secrets.mjs` dan `pnpm audit`.

## 6b. Halaman legal
`/syarat /privasi /refund /dpa /penggunaan-wajar /tentang` masih **DRAF**. Sebelum launch: tinjau penasihat hukum, isi identitas usaha di `/tentang` (placeholder `[ISI SEBELUM LAUNCH]`), naikkan `LEGAL_VERSION` (`packages/core/src/legal.ts`) bila isi berubah material.

## 6c. Pembayaran (M7)
- Aktifkan dengan `PAYMENT_PROVIDER=midtrans`, `MIDTRANS_SERVER_KEY`, `MIDTRANS_ENV` (kunci sandbox berawalan `SB-` hanya cocok dengan `sandbox`; start gagal bila tidak cocok) di **web dan worker** (worker juga butuh `BETTER_AUTH_URL`). Kosong = pembayaran mati dan jenis berDP ditolak.
- Daftarkan URL notifikasi di dashboard Midtrans: `https://<domain>/api/webhooks/payments`. Endpoint membalas 400 untuk tanda tangan salah, 200 untuk sisanya (duplikat/diabaikan), 500 untuk galat sementara (penyedia mencoba ulang).
- **Mengaktifkan penyedia jasa (operator, setelah KYC/ketentuan penyedia dipenuhi):** `INSERT INTO payment_accounts (workspace_id, provider, provider_account_id, kyc_status) VALUES ('<ws>', 'midtrans', '<merchant id>', 'verified');` Staf tidak dapat mengesahkan sendiri.
- Pemeriksaan harian: pembayaran macet `SELECT id, status, expires_at FROM payments WHERE status IN ('created','pending') AND expires_at < now() - interval '10 minutes';` (job rekonsiliasi menyapu tiap 2 menit; bila ada yang bertahan, periksa log worker). Webhook gagal: `SELECT * FROM webhook_inbox WHERE status = 'failed' ORDER BY received_at DESC;` (mis. nominal tidak cocok: selidiki manual, jangan dipaksa).
- Bayar terlambat (setelah slot dilepas) otomatis direfund penuh; pantau `payment_events` bersumber `system`.
- **Produksi diblokir** sampai model sub-merchant/split penyedia dipastikan (docs/adr/0001, docs/midtrans/).

## 7. Dev lokal
Lihat CLAUDE.md (compose, port 5433, `ensure-bucket`, E2E `pnpm e2e`).
