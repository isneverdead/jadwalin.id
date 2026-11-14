# Model data inti

Semua tabel tenant (termasuk tabel anak seperti ticket_comments) memiliki `workspace_id` + RLS. `id` = UUID. Waktu = `timestamptz`. Uang = `bigint` Rupiah.
Nama tabel snake_case, Inggris. Status berupa enum Postgres.

## 1. Akun, workspace, peran
| Tabel | Kolom penting |
|---|---|
| `users` | id, email (unik), phone (`62xxx`, unik, nullable), name, locale, created_at. Akun tunggal untuk penyedia, staf, dan klien. |
| `workspaces` | id, slug (unik, untuk `jadwalin.id/slug`), name, timezone (default `Asia/Jakarta`), owner_user_id, plan_id |
| `workspace_members` | workspace_id, user_id, role (`owner`/`admin`/`staff`), status |
| `workspace_clients` | workspace_id, user_id (nullable untuk tamu), name, email, phone, notes. Klien dari sisi sebuah workspace; bisa dikaitkan ke akun "Jadwal saya". |

Auth (sesi, akun OAuth, verifikasi) dikelola Better Auth di tabel miliknya sendiri.

## 2. Mesin jadwal (core)
| Tabel | Kolom penting |
|---|---|
| `meeting_types` | workspace_id, slug, title, duration_min, buffer_before_min, buffer_after_min, location_kind (`link`/`phone`/`in_person`), location_value, min_notice_min, max_days_ahead, active |
| `availability_rules` | workspace_id, member_id, weekday (0–6), start_time, end_time. Jam rutin mingguan. |
| `availability_overrides` | workspace_id, member_id, date, kind (`blocked`/`extra`), start_time, end_time. Libur/cuti atau jam tambahan per tanggal. |
| `bookings` | workspace_id, meeting_type_id, member_id, client_id, ticket_id (nullable), during `tstzrange`, status (`pending`/`confirmed`/`cancelled`/`completed`/`no_show`), source, cancel_token, notes |
| `calendar_connections` | workspace_id, member_id, provider (`google`), tokens terenkripsi, sync_state. Fase berikutnya. |

Anti-bentrok: `EXCLUDE USING gist (member_id WITH =, during WITH &&) WHERE (status IN ('pending','confirmed'))`.
`during` sudah mencakup buffer agar slot bersebelahan tidak bertabrakan.

## 3. Penyimpanan file (core)
| Tabel | Kolom penting |
|---|---|
| `files` | workspace_id, storage_key (R2), filename, mime, size_bytes, sha256, uploaded_by, status (`pending`/`ready`/`deleted`), created_at |

Akses lewat URL bertanda tangan berumur pendek. Batas ukuran dan tipe diatur dari entitlements.

## 4. Notifikasi (core)
| Tabel | Kolom penting |
|---|---|
| `notification_outbox` | workspace_id, channel (`email`/`whatsapp`), recipient, template, payload jsonb, send_at, status (`queued`/`sent`/`failed`/`skipped_quota`), attempts, provider_message_id |
| `notification_quota_usage` | workspace_id, period (bulan), channel, used, limit |

## 5. Pembayaran (core; dipakai mulai Booking + DP)
| Tabel | Kolom penting |
|---|---|
| `payment_accounts` | workspace_id, provider, provider_account_id (sub-account), kyc_status |
| `payments` | workspace_id, amount_idr, platform_fee_idr, status (state machine), provider, provider_ref, subject_type, subject_id, idempotency_key |
| `payment_events` | payment_id, from_status, to_status, source (`webhook`/`api`/`reconcile`/`admin`), raw jsonb, created_at. Append-only (tanpa UPDATE/DELETE). |
| `webhook_inbox` | provider, event_id (unik per provider), payload, received_at, processed_at, status |
| `refunds` | payment_id, amount_idr, status, reason |

## 6. Langganan dan entitlements (core)
| Tabel | Kolom penting |
|---|---|
| `plans` | id, code, module, price_idr, interval |
| `plan_entitlements` | plan_id, key (mis. `max_meeting_types`, `max_file_mb`, `wa_messages_per_month`), value |
| `subscriptions` | workspace_id, plan_id, status, current_period_start/end |

## 7. Log audit dan metrik
| Tabel | Kolom penting |
|---|---|
| `audit_log` | workspace_id (nullable), actor_user_id, action, entity_type, entity_id, diff jsonb, ip, created_at. Append-only. |
| `metric_events` | workspace_id, module, event (`signup`/`activated`/`paid`/`churned`), occurred_at. Sumber dashboard metrik per modul. |

## 8. Modul Tiket (`packages/modules/tickets`)
| Tabel | Kolom penting |
|---|---|
| `tickets` | workspace_id, number (urut per workspace), title, description, status (`open`/`in_progress`/`waiting_client`/`resolved`/`closed`), priority (`low`/`normal`/`high`/`urgent`), requester_user_id, assignee_member_id (nullable), client_id, created_at, closed_at |
| `ticket_comments` | ticket_id, author_user_id, body, internal (bool; catatan internal tidak terlihat klien) |
| `ticket_attachments` | ticket_id, file_id, comment_id (nullable), context_note (konteks lampiran), uploaded_by |
| `ticket_events` | ticket_id, actor_user_id, kind (`status`/`assign`/`priority`/`meeting`), from, to, created_at. Riwayat perubahan. |
| `ticket_meetings` | ticket_id, booking_id. Satu tiket bisa punya beberapa meeting. |

Izin: klien hanya melihat tiket dengan `requester_user_id` miliknya dan komentar non-internal. Anggota workspace melihat semua tiket di workspace-nya.

## 9. Alur kunci
- **Tamu memesan lewat link:** pilih `meeting_type` → hitung slot dari `availability_rules` + `availability_overrides` − `bookings` aktif → insert `bookings` (constraint menolak bentrok) → buat/tautkan `workspace_clients` dan `tickets` → antre email konfirmasi dan pengingat di outbox.
- **Meeting dari tiket:** staf menjadwalkan `booking` dengan `ticket_id` → `ticket_meetings` + `ticket_events`.

## Tambahan M3
- `notification_outbox`: `workspace_id` nullable (email sistem), `dedupe_key` unik global, `status` ∈ queued/sending/sent/failed/skipped_quota, `locked_at`, `last_error`. Dibaca/diubah worker lewat role `jadwalin_worker`.
- `notification_quota_usage`: unik (workspace, periode YYYY-MM, kanal); `used` dinaikkan atomik hanya bila belum melewati `limit_count`.
- `workspace_invitations`: menyimpan SHA-256 token (bukan token), satu undangan aktif per email per workspace, sekali pakai. Penerima membacanya lewat konteks `app.invite_token_hash`.
- Tabel Better Auth (`sessions`, `accounts`, `verifications`, `rate_limits`) tidak di-grant ke role aplikasi.

## Tambahan M4 (tiket)
- `tickets`: `updated_at`, `last_activity_at`; `requester_user_id` null untuk klien tamu; `client_id` selalu diisi oleh layanan.
- `ticket_counters`: nomor urut per workspace tanpa celah (baris dikunci selama transaksi).
- `ticket_comments.author_kind` ('client'/'staff'); `ticket_attachments.client_visible`; `ticket_events.client_visible` (penugasan tidak terlihat klien). Komentar dan riwayat tanpa UPDATE/DELETE untuk role aplikasi.
- `workspace_clients.blocked`; satu catatan klien per (workspace, user).
- Mode aktor klien: `app.actor_kind = 'client'` + fungsi `is_client_actor()`; policy RESTRICTIVE per tabel (migrasi 0009). Pencarian workspace publik lewat `app.public_slug`.

## Tambahan M5 (booking publik)
- `bookings`: `cancel_token_hash` (SHA-256; token mentah hanya di email), `starts_at`/`ends_at` (waktu pertemuan aktual; `during` memuat buffer untuk anti-bentrok), `source` ∈ staff/client_portal/public_link.
- `meeting_type_hosts`: anggota yang melayani jenis pertemuan; slot publik = gabungan slot host.
- `rate_counters`: pembatas laju jendela-tetap bergantung kunci ber-hash (bukan tabel tenant; dibersihkan worker).
- `notification_outbox.status` + `cancelled` (pengingat yang dibatalkan saat booking dibatalkan/dijadwal ulang).
- `workspace_clients`: satu catatan tamu per (workspace, email) selama `user_id` null; diklaim pemilik email terverifikasi.
- Aktor `public` (`app.actor_kind = 'public'`, `app.booking_token_hash`) dan fungsi `is_public_actor()` / `current_booking_token_hash()`; role worker punya hak sempit klaim (kolom `user_id`/`requester_user_id` pada baris tanpa pemilik).

## Tambahan M6
- `users.terms_version/terms_accepted_at`: bukti persetujuan Syarat+Privasi (diisi server setelah pendaftaran). `workspace_clients.consent_version/consent_at`: pengakuan pemberitahuan privasi tamu.
- `data_requests` (milik pengguna, bukan tenant): permintaan hak data; RLS `own_requests` (pengguna hanya melihat/membuat miliknya, status awal `pending`, satu tertunda per jenis); status diubah operator, bukan role aplikasi.
- `job_status`: status pekerjaan latar untuk pemantauan (app baca, worker tulis).
- `audit_log`: worker boleh INSERT dengan `workspace_id` NULL (peristiwa auth, email di-hash); tampilan workspace hanya admin ke atas.
- Migrasi 0015–0021 (lihat folder); `security-audit.test.ts` wajib diperbarui saat ada tabel baru.

## Tambahan M7 (pembayaran + DP; ADR 0001)
- `meeting_types.deposit_idr` (bigint, 0 = gratis). Booking berDP ditahan `pending` sampai lunas; lunas → `confirmed`; kedaluwarsa/gagal → `cancelled`.
- `payment_accounts`: akun merchant/sub-account milik penyedia jasa; `kyc_status` hanya diubah operator (staf boleh mendaftar, selalu `pending`). Tanpa akun `verified`, pembayaran dan pemesanan jenis berDP ditolak (aturan #3).
- `payments`: nominal `bigint`, `platform_fee_idr` dari entitlements (`platformFeeBps`), status lewat state machine `payment-state.ts`; role aplikasi hanya SELECT; semua tulis lewat role worker/`asWorker`. Unik `(workspace, idempotency_key)` dan `(provider, provider_ref)`.
- `payment_events`: append-only (tanpa UPDATE/DELETE/TRUNCATE untuk app dan worker); tiap transisi menulis satu baris di transaksi yang sama.
- `webhook_inbox`: bukan tabel tenant; hanya worker; unik `(provider, event_id)`.
- `refunds`: kunci idempoten ke penyedia unik; refund hanya dari status `paid/partially_refunded`.
- RLS klien/tamu: `ext_payment_read` membatasi baca pembayaran ke booking yang terlihat bagi mereka; akun pembayaran dan refund tertutup total.
- Migrasi 0022–0024. Worker mendapat hak sempit: kolom tertentu `bookings` (status saja untuk `pending → confirmed|cancelled`) dan kolom judul `meeting_types`.

## Pembayaran manual (M7 revisi; ADR 0002)
- Arah berubah: tanpa gateway. Penyedia jasa mengatur `payment_methods` (bank/QRIS/e-wallet/lainnya); pelanggan membayar di luar sistem dan mengunggah bukti (`payment_proofs`); staf memverifikasi. `payments` dipakai dengan `provider = 'manual'`, `platform_fee_idr = 0`.
- Status baru `awaiting_verification`: `pending → awaiting_verification → paid | pending (ditolak)`; staf juga boleh `pending → paid` (tunai). Jejak tetap di `payment_events` (aturan #10).
- `payment_proofs.status`: `draft` (unggahan diminta; mengikat berkas ke pembayaran) → `submitted` → `accepted | rejected`. `files.uploaded_by` NULL untuk berkas pelanggan tanpa akun.
- RLS (migrasi 0025–0027): metode bayar hanya terbaca pelanggan yang memegang token booking (tamu) atau bookingnya sendiri (klien); bukti tertutup bagi pelanggan; penulisan pelanggan hanya lewat worker (`asWorker`) setelah token divalidasi.
- Jendela bayar 3 jam (`MANUAL_HOLD_MIN`); 'menunggu verifikasi' tidak dikedaluwarsakan; ditolak → +60 menit.

## Tambahan: sewa barang (ADR 0003; migrasi 0029–0031)
- `workspaces.features` (jsonb): fitur per halaman (`tiket`, `pembayaran`, `berkas`, `sewa`); kunci yang hilang = aktif, kecuali `sewa` (bawaan mati).
- Core: `resources` (id, workspace_id, name, units 1–50, active) dan `reservations` (resource_id, unit_no, client_id, `during` tstzrange, status pending|confirmed|active|completed|cancelled|rejected, `token_hash` unik, notes). Exclusion constraint `reservations_no_overlap` pada (resource_id, unit_no, during) untuk status pending/confirmed/active.
- Modul rental: `rental_products` (resource_id unik, nama, kategori, deskripsi, harga per hari, uang jaminan, foto, urutan, aktif) dan `rental_orders` (reservation_id unik, product_id, start_date, end_date, days, harga/hari, total, catatan pelanggan/staf).
- RLS: keempat tabel tenant_isolation + `client_denied`; tamu: baca katalog aktif/reservasi aktif, buat reservasi `pending`, baca/batalkan lewat token; foto produk lewat `public_files_read`.
