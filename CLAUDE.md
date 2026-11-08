# jadwalin.id

Super app penjadwalan untuk pasar Indonesia. Satu INTI platform dipakai oleh banyak modul.
Bahasa UI dan teks pengguna: Bahasa Indonesia. Kode, nama tabel, dan komentar: Inggris.

## Stack (disetujui)
TypeScript, pnpm workspaces + Turborepo, Next.js (App Router), PostgreSQL 16 + Drizzle ORM,
BullMQ + Redis, Zod, Better Auth, Vitest + Testcontainers, Playwright, Docker, GitHub Actions.
Penyimpanan file: Cloudflare R2. Observability: Sentry + log terstruktur (pino).

## Struktur repo
```
apps/web        dashboard, halaman publik, portal klien "Jadwal saya"
apps/admin      admin internal untuk support
apps/worker     antrian, cron, pemroses webhook
packages/core   INTI: workspace, scheduling, payments, notifications, files, billing/entitlements
packages/db     skema Drizzle, migrasi SQL, RLS, seed
packages/modules/<nama>   tickets, booking, wa-admin, recurring-billing, classes, events
packages/ui     komponen bersama (UI Bahasa Indonesia)
packages/config tsconfig, eslint, skema env
infra/          compose, deploy, skrip backup dan restore
docs/           ADR, data-model.md, milestones.md, runbook
```

## Aturan arsitektur (WAJIB)
1. `core` tidak boleh mengimpor dari `modules/*`. Modul boleh mengimpor `core`, TIDAK boleh mengimpor modul lain. Dipaksa lint (`dependency-cruiser`, perintah `pnpm depcheck`); CI gagal jika dilanggar.
2. Modul DILARANG membuat sistem pembayaran, notifikasi, kalender/jadwal, atau penyimpanan file sendiri. Pakai antarmuka `core`.
3. jadwalin TIDAK PERNAH menampung uang pihak ketiga. Pembayaran lewat gateway dengan sub-account/split; jadwalin hanya mengambil fee platform.
4. Hanya WhatsApp Business API resmi lewat BSP. Admin AI wajib bisa alih ke manusia dan memberi tahu klien bahwa balasan berasal dari sistem otomatis.
5. Uang = integer Rupiah (`bigint`), tidak pernah float.
6. Nomor HP dinormalisasi ke `62xxx` lewat SATU fungsi di `core`, dipanggil dari semua titik masuk.
7. Waktu disimpan `timestamptz` (UTC). Tampilan memakai zona workspace, default `Asia/Jakarta`. Zona dibatasi WIB/WITA/WIT (offset tetap, tanpa DST); menambah zona lain butuh ADR.
8. Anti-bentrok jadwal ditegakkan di database (exclusion constraint), bukan hanya di kode.
9. Setiap tabel milik tenant punya `workspace_id` dan Row-Level Security aktif. Query tanpa konteks workspace harus gagal.
10. Perubahan status pembayaran wajib lewat state machine dan menulis baris `payment_events` (append-only). Webhook diproses idempoten lewat `webhook_inbox` dengan kunci ID event penyedia.
11. Pengiriman notifikasi lewat outbox; kuota per paket dicek dan dikurangi dalam transaksi yang sama.
12. Batas fitur per paket dibaca dari entitlements di `core`, jangan hard-code di modul.
13. Tanpa secret di kode. Env divalidasi Zod saat start (`packages/config`). Hanya `.env.example` yang di-commit.

## Alur kerja
- Satu repo, satu branch per modul (`module/tickets`, `module/booking`, ...), inti di `core/*`.
- Tes wajib lulus sebelum merge. Tidak ada deploy langsung ke produksi: staging dulu (gateway mode test), produksi lewat promosi manual.
- Migrasi DB: SQL di `packages/db/migrations`, maju-saja, direview sebelum merge.
- Setiap alur pembayaran, refund, dan webhook (termasuk webhook ganda dan telat) wajib punya tes otomatis.
- Perubahan yang menyentuh aturan di atas butuh ADR di `docs/adr/`.
- Akses data tenant HANYA lewat `withWorkspace` (core, memeriksa keanggotaan dan peran) atau `withTenant` (db, role `jadwalin_app` + RLS). Jangan memakai pool mentah untuk tabel tenant, dan jangan percaya `workspaceId` dari input pengguna.
- Setiap migrasi yang membuat tabel tenant baru wajib: `workspace_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `tenant_isolation`, dan `GRANT` eksplisit ke `jadwalin_app`. Tabel milik auth/sistem sengaja TIDAK di-grant.
- `migrateUp` diimpor dari `@jadwalin/db/migrate` (bukan dari index) agar tidak ikut ter-bundle ke Next.js.
- FK Postgres tidak melewati RLS: setiap fungsi yang menerima id entitas dari input (klien, tiket, anggota) wajib memastikan entitas itu terlihat di konteks workspace sebelum dipakai.
- Logika jadwal murni (`slots.ts`) tidak boleh membaca jam sistem atau DB; semua masukan eksplisit supaya bisa diuji properti.
- Tes yang memakai DB harus aman dijalankan berulang: data unik (email, HP, token, IP) dibuat acak per run.
- Pengguna BIASA (klien, bukan anggota) hanya boleh mengakses data lewat `withClientAccess` (konteks tenant `actor = client`). Setiap tabel tenant baru wajib diputuskan perlakuannya untuk klien di migrasinya: tertutup total (`client_denied`) atau dibatasi baris (policy RESTRICTIVE, hanya `TO jadwalin_app`) lalu diuji dengan SQL mentah. Jangan menyalurkan data klien lewat `withWorkspace`.
- Tamu TANPA AKUN hanya boleh masuk lewat `withPublicWorkspace` (aktor `public`, RLS migrasi 0011): menulis booking/klien tamu/tiket anonim, tidak membaca apa pun yang sensitif. Token rahasia (undangan, kelola booking) selalu disimpan sebagai hash (`hashToken`) dan token mentah hanya ada di email; email yang memuatnya memakai template `booking_notice`/`SENSITIVE_TEMPLATES` agar payload dihapus setelah terkirim.
- Core tidak mengenal tiket: booking publik memanggil hook (`BookingHooks`) yang dipasang lapisan aplikasi (`ticketBookingHooks`). Modul tidak boleh saling mengimpor; komposisi lintas-modul terjadi di `apps/`.
- Di templat SQL Drizzle jangan menyisipkan array JS (`${arr}::uuid[]` rusak): pakai `sql.join(...)` dengan `IN (...)`. Pada UPDATE, Postgres juga mengevaluasi policy SELECT terhadap baris BARU; rancang policy baca yang tetap mencakup baris hasil ubah.
- Perlindungan bot: Turnstile diverifikasi di server (`verifyTurnstile`, gagal tertutup) + pembatas laju DB (`consumeRateLimit`) + honeypot; jangan membuka endpoint tulis publik tanpa ketiganya.
- Mengantre email dari aksi klien memakai `asWorker` (peralihan role sementara di dalam transaksi), bukan memberi klien hak menulis outbox.
- Proses latar (worker, email sistem) memakai `withWorker` (role `jadwalin_worker`, hak terbatas dan policy RLS eksplisit); jangan melebarkan haknya tanpa ADR. Pesan email SELALU lewat `enqueueEmail` di transaksi yang sama dengan perubahan bisnis, dengan `dedupeKey` bila bisa terpicu ulang. Template yang memuat token wajib masuk `SENSITIVE_TEMPLATES`.
- Berkas: jangan membuat jalur unggah/unduh sendiri di modul; pakai `createPendingFile`/`finalizeFile`/`signDownload` dari core setelah otorisasi domain modul. Tipe diizinkan ditentukan `ALLOWED_MIME_TYPES` (tanpa HTML/SVG).
- Tes DB berjalan berurutan (`fileParallelism: false`, `turbo --concurrency=1`) karena dispatcher outbox lintas-workspace; tes yang menjalankan worker wajib menutupnya sendiri.
- E2E: `pnpm e2e` (Playwright, build produksi di port 3100). Prasyarat: Postgres/S3 jalan, `ensure-bucket` sudah dijalankan (CORS origin 3100), worker TIDAK berjalan (ia menghapus payload email yang dibaca tes), env DATABASE_URL dan S3_* diekspor. Tes bersama bucket: jangan menimpa CORS bucket dari tes.
- Dev lokal: `docker compose -f infra/docker-compose.yml up -d` (Postgres 5433, Redis, S3 RustFS 9100), lalu `pnpm --filter @jadwalin/worker ensure-bucket` sekali. Jika `docker pull` macet di macOS, penyebabnya credential helper Docker Desktop: tarik dengan `DOCKER_CONFIG` berisi `{}` dan `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`.
- Dev lokal: Postgres proyek di port **5433** (5432 sering dipakai Postgres lain). `apps/web/.env.local` berisi rahasia dev dan tidak di-commit.

- Tabel baru wajib diklasifikasikan di `packages/db/test/security-audit.test.ts` (tenant atau daftar NON_TENANT beserta alasan); tes juga menjaga siklus policy RLS (rekursi tak terbatas). Jangan membuat policy yang saling merujuk lewat subquery antar-tabel.
- Produksi di belakang Cloudflare: `TRUST_PROXY=cloudflare`, IP hanya dari `cf-connecting-ip`; origin wajib dikunci ke Cloudflare. Jangan mempercayai `x-forwarded-for`.
- Sentry/log: tanpa PII, token, atau isi permintaan (`scrubEvent`); jangan menambah konteks yang memuat email/HP/URL bertoken.
- Backup: klien `pg_dump/pg_restore` satu versi mayor dengan server (`PG_BIN_DIR`); passphrase tidak boleh di repo/bucket yang sama; ubah format backup = naikkan versi header + uji restore.
- Dokumen legal bersifat DRAF sampai ditinjau hukum; naikkan `LEGAL_VERSION` bila isi berubah material. Pendaftaran dari browser wajib `termsAccepted`; booking tamu wajib `privacyAck`.
- Sebelum merge: `pnpm run ci` (typecheck, depcheck, tes) dan `node scripts/check-secrets.mjs`.

- Pembayaran (ADR 0001): status pembayaran HANYA berubah lewat `transition()` di `core/payments.ts` (state machine + `payment_events`); jangan `UPDATE payments` langsung. Panggilan ke penyedia tidak boleh di dalam transaksi DB. Role aplikasi hanya membaca `payments`; penulisan lewat `withWorker`/`asWorker`. Webhook: verifikasi tanda tangan dulu, lalu `webhook_inbox` (idempoten); nominal `paid` harus sama persis. Tanpa `payment_accounts` terverifikasi, pembayaran/pemesanan berDP ditolak. Penyedia baru = adapter `PaymentProvider` + tes kontrak yang sama; `fake` dilarang di produksi (`ALLOW_FAKE_PAYMENTS` hanya untuk uji).
- `asWorker` kembali ke role SEBELUMNYA (bukan selalu `jadwalin_app`), supaya hook yang mengantre email aman di dalam `withWorker`.

## Standar sebelum launch
Review keamanan (auth, isolasi workspace, rate limit, tanpa secret), backup DB harian + uji restore, monitoring error/uptime, log audit status pembayaran, halaman legal (syarat layanan, privasi, refund, perjanjian pemrosesan data, kebijakan penggunaan wajar, identitas usaha), kepatuhan UU PDP / PP 33/2026 (persetujuan, hak subjek data, DPIA untuk Admin AI dan data kesehatan).

## Perintah
```
pnpm install
pnpm dev            # semua app
pnpm test           # vitest
pnpm typecheck
pnpm lint
docker compose -f infra/docker-compose.yml up -d   # Postgres + Redis lokal
pnpm --filter @jadwalin/db migrate
```
