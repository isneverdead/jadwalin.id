# Milestone

Urutan dipimpin kebutuhan sendiri: **modul Tiket dulu** (dipakai oleh pemilik), lalu Booking + DP.
Setiap milestone selesai hanya jika SEMUA kriteria terpenuhi dan tes lulus di CI.

## M0 — Fondasi (minggu 1–2)
- Monorepo pnpm + Turborepo, lint boundaries aktif, CI (typecheck, lint, test).
- Postgres + Redis lokal via Docker; migrasi berjalan dari nol.
- Validasi env Zod; tidak ada secret di repo.
- Staging terpisah ter-deploy otomatis dari `main`.
**Selesai jika:** CI hijau, `docker compose up` + `pnpm dev` jalan di mesin bersih, deploy staging berhasil, uji pelanggaran boundary membuat CI gagal.

## M1 — Akun, workspace, peran (minggu 2–3)
- Daftar/masuk (email), workspace dengan slug, anggota dan peran, akun klien.
- RLS aktif di semua tabel tenant; sesi membawa konteks workspace.
**Selesai jika:** tes isolasi membuktikan user workspace A tidak bisa membaca/menulis data workspace B (API dan SQL langsung); rate limit di login.

**Status: selesai (2 Nov 2026).** Email + kata sandi (Better Auth, sesi di DB), workspace dengan slug, peran owner/admin/staf, akun klien + "Jadwal saya", log audit, rate limit login 5/menit/IP (tersimpan di DB). Lulus: tes isolasi workspace (lewat API `withWorkspace` dan SQL langsung), tes izin peran, tes rate limit via handler dan via server HTTP sungguhan, uji manual daftar → buat workspace di browser.

**Belum dikerjakan, dicatat sebagai utang (jangan dilupakan sebelum launch):**
- Verifikasi email dan reset kata sandi: butuh outbox email (M3). Sampai itu ada, jangan tambah anggota dari email yang tidak Anda kenal; email belum terbukti milik orangnya.
- Menambah anggota lewat email membuka celah mengecek apakah sebuah email terdaftar (enumerasi). Ganti ke undangan berbasis token di M3 dan beri rate limit.
- Rate limit membaca IP dari `x-forwarded-for`; saat deploy di belakang Cloudflare, atur `advanced.ipAddress.ipAddressHeaders` ke `cf-connecting-ip` agar klien tidak bisa memalsukannya.
- Peran `owner` tidak bisa dipindahkan/ditransfer; belum ada hapus workspace.
- `apps/admin` dan `apps/worker` belum dibuat (worker dibutuhkan di M3).

## M2 — Mesin jadwal (minggu 3–5)
- Meeting types, jam rutin mingguan, override tanggal, perhitungan slot (buffer, min notice, rentang hari, zona waktu).
- Exclusion constraint anti-bentrok.
- Antarmuka pengaturan ketersediaan di dashboard.
**Selesai jika:** tes properti untuk perhitungan slot; tes konkurensi (dua booking serentak pada slot sama → satu gagal); tes zona waktu WIB/WITA/WIT.

**Status: selesai (8 Nov 2026).** Mesin slot murni ([slots.ts](../packages/core/src/slots.ts)), layanan jadwal ([scheduling.ts](../packages/core/src/scheduling.ts)), halaman `/w/[slug]/jadwal`. Lulus: tes properti (300 kombinasi acak: slot terurut, tanpa duplikat, menghormati pemberitahuan minimum, batas hari, buffer, bentrok, dan oracle independen untuk jam rutin/override), tes zona waktu WIB/WITA/WIT, 8 booking serentak → tepat 1 berhasil dan 7 gagal sebagai `slot_unavailable`, isolasi antar-workspace (klien/tiket workspace lain ditolak), izin peran, dan uji manual di browser.

**Keputusan desain M2 (perlu Anda tahu):**
- Zona waktu workspace dibatasi ke Asia/Jakarta, Asia/Makassar, Asia/Jayapura (tanpa DST, offset tetap), dijaga constraint DB. Belum ada UI untuk mengganti zona.
- Buffer menempel pada tiap booking: jarak antar dua pertemuan = buffer sesudah yang pertama + buffer sebelum yang kedua. Dengan buffer 30/30, jaraknya 60 menit. Mesin dan constraint DB memakai aturan yang sama.
- Langkah slot dihitung dari awal jendela jam rutin (jendela 09:00 + langkah 30 → 09:00, 09:30, …).
- Satu anggota = satu kalender. Jam rutin per anggota; staf hanya mengatur miliknya, admin+ mengatur siapa saja.
- `createBooking` memverifikasi klien/tiket milik workspace yang sama (FK tidak melewati RLS).

**Belum dikerjakan:** sinkron Google Calendar (anti-bentrok dengan jadwal di luar jadwalin) ditunda; link booking publik M5; UI membuat booking dari dashboard (datang bersama Tiket M4).

## M3 — Penyimpanan file & notifikasi email (minggu 4–5)
- Upload ke R2 via URL bertanda tangan, batas ukuran/tipe, unduh bertanda tangan berumur pendek.
- Outbox email + worker BullMQ dengan retry dan kuota.
**Selesai jika:** file hanya bisa diakses anggota yang berhak; email terkirim, gagal → retry; tes idempoten pada pengiriman ganda.

**Status: selesai (8 Nov 2026).** Penyimpanan berkas ([files.ts](../packages/core/src/files.ts), [storage.ts](../packages/core/src/storage.ts)), outbox email dengan kuota ([notifications.ts](../packages/core/src/notifications.ts)), pengirim SMTP/console, `apps/worker` (BullMQ + Redis). Ikut dikerjakan karena utang M1: verifikasi email, reset kata sandi, dan undangan anggota berbasis token (menggantikan "tambah anggota lewat email" yang membuka enumerasi akun).

Lulus: 117 tes (dua kali berturut-turut) di Postgres, Redis, dan S3 sungguhan, ditambah uji browser (daftar → verifikasi lewat tautan email → undang → terima; unggah langsung dari browser; unduh).
- Berkas: unggah via URL ber-tanda-tangan 5 menit yang terikat tipe isi; ukuran dan tipe diperiksa ulang saat konfirmasi (objek yang tidak cocok dihapus); unduh via URL 60 detik, selalu `attachment`; URL kedaluwarsa terbukti 403; akses dibatasi anggota workspace; pembersihan unggahan yatim oleh worker; tiap URL unduh tercatat di audit.
- Email: outbox transaksional (rollback bisnis = pesan ikut batal), dedupe idempoten, kuota bulanan dikurangi atomik (30 enqueue paralel pada sisa 10 → tepat 10), retry dengan backoff 1m/5m/30m/2j/6j lalu `failed`, 4 dispatcher serentak tidak pernah mengirim ganda, pesan macet diambil ulang setelah 10 menit, payload berisi token dihapus dari DB setelah terkirim.
- Auth: login diblokir sampai email terverifikasi; reset sandi mencabut sesi lama dan token sekali pakai; permintaan reset untuk email tak dikenal tidak membocorkan akun; rate limit reset 5/jam/IP.
- Undangan: token hanya ada di email (DB menyimpan hash), sekali pakai (5 penerimaan serentak → 1 berhasil), 7 hari, hanya untuk akun dengan email yang sama dan terverifikasi.

**Keputusan M3 (perlu Anda tahu):**
- Email at-least-once: bila worker mati tepat setelah mengirim dan sebelum mencatat, pesan bisa terkirim dua kali setelah 10 menit. Penyedia email kelak sebaiknya dipilih yang mendukung kunci idempoten.
- Penyedia email belum dipilih: ada adapter SMTP umum. Tanpa `SMTP_URL` email dicetak ke log (khusus dev; produksi menolak start tanpa `SMTP_URL`).
- Entitlements masih konstanta bawaan (10 MB, 1000 email/bulan) sampai tabel paket di M7.
- Tidak ada pemindaian virus pada unggahan; tipe berbahaya (HTML/SVG/skrip) ditolak dan semua unduhan dipaksa `attachment`.
- Worker memakai role DB `jadwalin_worker` dengan hak terbatas (outbox dan berkas) lewat policy RLS eksplisit, bukan superuser.

**Utang yang tersisa:**
- Email "kirim ulang verifikasi" hanya lewat percobaan masuk (belum ada tombol).
- Berkas belum punya kuota total per workspace.
- CORS bucket produksi (R2) harus diatur manual di dashboard Cloudflare; skrip `ensure-bucket` hanya untuk lokal/CI.
- Alur CI GitHub (termasuk service Redis dan RustFS) belum pernah dijalankan di GitHub.

## M4 — Modul Tiket (minggu 5–7) — slice pertama yang dipakai
- Klien (punya akun) membuat tiket lewat portal "Jadwal saya"; tiket ditunjuk ke anggota.
- Status, prioritas, komentar (publik dan internal), riwayat perubahan.
- Lampiran per tiket dengan catatan konteks.
- Jadwalkan meeting dari tiket (link manual per jenis pertemuan).
**Selesai jika:** alur ujung ke ujung lolos E2E Playwright (klien buat tiket → staf ambil → lampiran → meeting); klien tidak melihat catatan internal; semua perubahan tercatat di `ticket_events`.

**Status: selesai (8 Nov 2026).** Modul [packages/modules/tickets](../packages/modules/tickets) (sisi staf, sisi klien, status, notifikasi), akses klien di core ([withClientAccess](../packages/core/src/workspace.ts)), migrasi `0008`–`0009`, halaman staf `/w/[slug]/tiket`, portal klien `/jadwal-saya/[slug]`, halaman publik `jadwalin.id/<slug>`, dan E2E ([e2e/tiket.spec.ts](../apps/web/e2e/tiket.spec.ts)).

Lulus: typecheck, depcheck, 144 tes (31 di modul tiket) dan E2E Playwright 3 kali berturut-turut, semuanya di Postgres/Redis/S3 sungguhan.
- **Isolasi klien ditegakkan di database**, bukan hanya di kode: klien masuk lewat konteks tenant `actor = client`, dan policy RESTRICTIVE (migrasi 0009) membatasi mereka pada tiket, komentar publik, lampiran terlihat, dan meeting milik sendiri. Diuji dengan SQL mentah: tidak bisa membaca anggota/outbox/kuota/undangan/audit, menulis atas nama orang lain, menyamar sebagai staf, membuat komentar internal, mengubah tiket orang lain, atau membuka blokir diri sendiri.
- Catatan internal dan lampiran tersembunyi tidak pernah sampai ke klien, termasuk di HTML halaman, dan tidak pernah diemailkan. Unduh lampiran tersembunyi oleh klien dijawab 404 walau id-nya diketahui.
- Nomor tiket berurutan tanpa celah walau dibuat serentak (6 paralel). Meeting dari tiket atomik: booking, tautan, riwayat, dan email commit bersama; slot rebutan dua tiket → tepat satu berhasil dan yang gagal tidak meninggalkan jejak parsial.
- Riwayat (`ticket_events`) dan komentar tidak bisa diubah/dihapus oleh role aplikasi; E2E memverifikasi urutan lengkap created → assign → status → attachment → attachment → meeting → status.
- Email (lewat outbox, atomik dengan aksinya): tiket baru → penanggung jawab atau owner/admin; balasan klien → penanggung jawab; balasan publik/selesai/ditutup/meeting → klien.

**Keputusan M4 (perlu Anda tahu):**
- **Portal terbuka untuk pengguna terverifikasi.** Siapa pun yang punya akun dengan email terverifikasi bisa membuka tiket di workspace mana pun lewat `jadwalin.id/<slug>` (catatan klien dibuat otomatis). Pengamanan: maksimal 10 tiket/24 jam dan 25 tiket terbuka per klien, plus admin bisa memblokir klien. Mode "hanya undangan" belum ada; tambahkan bila spam jadi masalah.
- Klien bisa menutup tiketnya sendiri dari status aktif mana pun (membatalkan permintaan) dan membuka kembali yang sudah diselesaikan; klien tidak bisa memulai pengerjaan atau menyelesaikan. Tiket yang sudah ditutup final (staf pun tidak bisa membukanya lagi).
- Staf menjadwalkan meeting di kalendernya sendiri; admin ke atas bisa di kalender siapa pun. Klien belum memilih slot sendiri di tiket (itu link publik M5).
- Nama staf tidak ditampilkan ke klien: yang terlihat "Tim <nama workspace>". Nama klien di sisi staf diambil dari catatan klien (klien bukan anggota, jadi tabel pengguna tak terlihat oleh staf).
- Komentar tidak bisa diedit/dihapus (jejak utuh). Belum ada pengeditan.

**Utang yang tersisa:**
- Klien tamu (dibuat staf tanpa akun) belum otomatis tertaut bila nanti mendaftar dengan email yang sama; tiketnya tidak muncul di portal akun itu. Ditangani bersama booking tamu di M5.
- Antarmuka belum punya paginasi (daftar dibatasi 100–200), notifikasi di dalam aplikasi, atau pencarian isi komentar.
- E2E mengosongkan tabel `rate_limits` di database uji agar bisa diulang dari IP yang sama (pembatas pendaftaran 10/jam/IP memang bekerja). CORS bucket dipasang lewat `ensure-bucket` (origin 3000 dan 3100); tes `core` tidak lagi menimpanya.
- Job E2E di GitHub Actions belum pernah dijalankan di GitHub.

## M5 — Link booking publik (minggu 7–8)
- `jadwalin.id/<slug>` dan `/<slug>/<jenis>`: tamu tanpa akun memilih slot, mengisi nama/kontak/topik.
- Booking otomatis membuat tiket baru (atau menempel ke tiket yang ada); email konfirmasi, pengingat, tautan batal/ubah jadwal.
- Perlindungan bot (Turnstile) dan rate limit.
**Selesai jika:** E2E tamu memesan sampai email terkirim; slot terpakai langsung hilang dari link; pembatalan membebaskan slot.

**Status: selesai (8 Nov 2026).** Booking publik di core ([public-booking.ts](../packages/core/src/public-booking.ts), [turnstile.ts](../packages/core/src/turnstile.ts), [rate-limit.ts](../packages/core/src/rate-limit.ts), [claim.ts](../packages/core/src/claim.ts)), hook tiket + booking klien terdaftar ([booking.ts](../packages/modules/tickets/src/booking.ts)), migrasi `0010`–`0014`, halaman `jadwalin.id/<slug>`, `/<slug>/<jenis>`, `/booking/<token>` (+ `/ubah`), pengaturan host di dashboard, dan E2E ([e2e/booking.spec.ts](../apps/web/e2e/booking.spec.ts)).

Lulus: typecheck, depcheck, 177 tes (125 core, 41 modul tiket, 7 db, 4 worker) dan 2 spec E2E, tiga kali berturut-turut, di Postgres/Redis/S3 sungguhan. E2E memakai kunci uji Cloudflare Turnstile sehingga widget dan verifikasi server benar-benar dipanggil.
- **Pemesanan tanpa akun**: tamu memilih waktu, mengisi nama/email/HP/topik; dibuat catatan klien tamu, booking, dan tiket (ditugaskan ke host) dalam satu transaksi. Slot yang dipesan langsung hilang untuk pengunjung lain; 8 pemesan serentak ke satu slot → tepat satu berhasil.
- **Banyak host**: slot publik = gabungan kalender host jenis pertemuan; booking dibagi ke host dengan beban terendah (dua pemesan ke slot yang sama dibagi ke dua host, yang ketiga ditolak).
- **Email**: konfirmasi + pengingat 24 jam dan 1 jam sebelum (diantre dengan `send_at`, dibatalkan/dijadwal ulang otomatis), pemberitahuan ke host, konfirmasi batal/ubah. Token kelola hanya ada di tautan email; DB menyimpan hash dan payload email dihapus setelah terkirim.
- **Kelola tanpa login** lewat tautan email: lihat, ubah jadwal (booking sendiri tidak menghalangi), batalkan. Token salah/hash/kosong tidak membuka apa pun; booking lewat waktu tidak bisa diubah.
- **Perlindungan**: Turnstile (gagal tertutup: token kosong, galat jaringan, atau respons janggal = ditolak), honeypot, pembatas laju di DB (10 percobaan/jam/IP termasuk yang gagal, 3 booking/hari/email, 300/hari/workspace, 10 aksi kelola/hari/token), validasi input.
- **RLS aktor tamu** diuji dengan SQL mentah: tamu tidak bisa membaca tiket, komentar, lampiran, berkas, anggota, outbox, kuota, undangan, atau audit; hanya menulis booking `public_link`, klien tamu, serta tiket/riwayat anonim; tidak bisa mengubah booking tanpa token.
- **Klien terdaftar** bisa memesan dari portal dan menempelkan meeting ke tiketnya yang sudah ada (tiket orang lain/ditutup ditolak; kegagalan slot tidak meninggalkan tiket yatim).
- **Klaim klien tamu** (utang M4 lunas): pemilik email TERVERIFIKASI yang sama otomatis memegang catatan klien dan tiket tamu itu saat membuka portal; akun belum terverifikasi tidak mengklaim apa pun.

**Keputusan M5 (perlu Anda tahu):**
- Jenis pertemuan punya **host eksplisit** (tabel `meeting_type_hosts`); pembuatnya otomatis jadi host dan jenis tanpa host disembunyikan dari halaman publik. Atur di dashboard Jadwal & ketersediaan.
- **Token kelola booking disimpan sebagai hash** (kolom `cancel_token` diganti `cancel_token_hash`), dan waktu pertemuan aktual disimpan di `starts_at`/`ends_at` (sebelumnya dihitung dari `during` + buffer saat ini, yang bisa bergeser bila buffer diubah).
- **Turnstile wajib di produksi** (`loadTurnstileEnv` menolak start tanpa kunci); di luar produksi tanpa kunci verifikasi dilewati. Pengguna yang sudah masuk tidak ditantang.
- Email konfirmasi dikirim ke alamat yang diketik tamu tanpa verifikasi (umum untuk booking, tetapi bisa disalahgunakan untuk membanjiri email orang lain). Pagar: Turnstile + 3 booking/hari/email + 10/jam/IP.
- Tamu yang memesan dengan email milik akun terdaftar membuat catatan klien tamu TERPISAH (tidak digabung otomatis tanpa verifikasi); tiketnya baru tertaut bila pemilik email membuka portal dan belum punya catatan klien di workspace itu.
- Pembatas IP memakai `cf-connecting-ip` bila ada, jika tidak hop pertama `x-forwarded-for` (bisa dipalsukan tanpa proxy tepercaya).

**Utang yang tersisa:**
- Sinkron Google Calendar belum ada (anti-bentrok dengan jadwal di luar jadwalin).
- Belum ada kebijakan batas waktu batal/ubah (mis. maksimal H-24) maupun batas jumlah ubah jadwal per booking selain 10 aksi/hari/token.
- Zona waktu tamu belum dideteksi: semua jam tampil dalam zona workspace (diberi label WIB/WITA/WIT).
- Halaman kelola belum punya tombol "tambahkan ke kalender" (.ics).
- Job E2E di GitHub Actions belum pernah dijalankan di GitHub; E2E bergantung pada jaringan ke Cloudflare (kunci uji Turnstile).

## M6 — Hardening slice pertama (minggu 8–9)
- Review keamanan (auth, isolasi, rate limit, secret), backup harian + uji restore, Sentry + uptime, log audit.
- Halaman legal minimal untuk pemakaian publik.
**Selesai jika:** restore backup berhasil diuji dan didokumentasikan di runbook; checklist keamanan lulus; Anda memakainya sendiri minimal 1 minggu.
**Status (2026-11-08): kode selesai.** Review keamanan + perbaikan temuan, backup terenkripsi + uji restore otomatis, Sentry/health/ready, log audit (tampilan admin), halaman legal draf, persetujuan, ekspor/hapus data. Lihat `docs/runbook.md` dan `docs/security-checklist.md`. Sisa: tindakan operator (⏳ di checklist) dan pemakaian ≥ 1 minggu.

## M7 — Booking + DP (minggu 9–12)
- Integrasi gateway (kandidat utama Midtrans — tinjau dukungan sub-merchant/split dulu; alternatif Xendit xenPlatform), QRIS/VA, state machine pembayaran, webhook idempoten, refund, rekonsiliasi.
- Entitlements dan langganan paket (Gratis/Pro/Bisnis), kuota WA.
**Selesai jika:** tes otomatis untuk pembayaran, refund, webhook ganda dan telat; staging memakai mode test gateway; `payment_events` mencatat setiap transisi.
**REVISI 2026-11-08 (ADR 0002):** pemilik memutuskan jadwalin TIDAK memproses pembayaran. Alur DP kini manual: penyedia jasa mengatur metode bayar (QRIS statis/rekening/e-wallet), pelanggan mengunggah bukti, staf memverifikasi (menu Pembayaran). Tidak ada blokir produksi dari gateway; kode Midtrans/fake dipertahankan nonaktif. Pendapatan hanya dari langganan (docs/pricing.md).
**Status sebelum revisi (gateway):** irisan inti selesai, produksi DIBLOKIR. Sudah: ADR 0001, skema + RLS, state machine (tes properti), antarmuka penyedia + adapter `fake` dan `midtrans` (sandbox), webhook idempoten + endpoint `/api/webhooks/payments`, refund (sebagian/penuh, anti-dobel), rekonsiliasi (job worker 2 menit), bayar terlambat otomatis direfund, booking publik berDP, UI DP + halaman kelola menampilkan status. Belum: DP lewat portal klien (ditolak gagal-tertutup), UI refund untuk staf, UI pengesahan akun pembayaran (operator via SQL), paket/langganan/kuota WA (entitlements baru `platformFeeBps` bawaan 0), E2E browser untuk alur DP, uji sandbox Midtrans sungguhan, kebijakan refund saat tamu membatalkan booking yang sudah dibayar. **Blokir produksi:** jawaban Midtrans soal model sub-merchant/split (aturan #3).

## Setelah M7
Modul lain (Admin AI WA, Tagihan berulang, Kelas & membership, Nikahan) dijadwalkan ulang setelah slice pertama terpakai dan dimasukkan ke dashboard metrik per modul sejak M1 (`metric_events`).
