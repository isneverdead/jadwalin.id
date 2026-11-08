-- ===== 1. Backfill data lama =====
-- RLS FORCE membuat pemilik tabel pun terkena policy; matikan sebentar hanya untuk backfill ini.
ALTER TABLE "bookings" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "meeting_types" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_members" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Token kelola booking disimpan sebagai hash SHA-256 (sama dengan hashToken() di core).
UPDATE "bookings" SET "cancel_token_hash" = encode(sha256(convert_to("cancel_token", 'UTF8')), 'hex') WHERE "cancel_token_hash" IS NULL;
--> statement-breakpoint
-- Waktu pertemuan sebenarnya = rentang `during` dikurangi buffer jenis pertemuannya.
UPDATE "bookings" b
SET "starts_at" = lower(b."during") + make_interval(mins => mt."buffer_before_min"),
    "ends_at" = upper(b."during") - make_interval(mins => mt."buffer_after_min")
FROM "meeting_types" mt
WHERE mt."id" = b."meeting_type_id" AND b."starts_at" IS NULL;
--> statement-breakpoint
-- Jenis pertemuan yang sudah ada: host awal = owner/admin workspace-nya.
INSERT INTO "meeting_type_hosts" ("workspace_id", "meeting_type_id", "member_id")
SELECT mt."workspace_id", mt."id", m."id"
FROM "meeting_types" mt
JOIN "workspace_members" m ON m."workspace_id" = mt."workspace_id" AND m."role" IN ('owner', 'admin')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "bookings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "meeting_types" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Satu catatan klien tamu per email per workspace (klien terdaftar dikecualikan).
CREATE UNIQUE INDEX "workspace_clients_guest_email" ON "workspace_clients" ("workspace_id", lower("email")) WHERE "user_id" IS NULL AND "email" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "bookings_member_starts" ON "bookings" ("member_id", "starts_at");
--> statement-breakpoint

-- ===== 2. Tabel baru =====
GRANT SELECT, INSERT, UPDATE, DELETE ON "meeting_type_hosts" TO jadwalin_app;
--> statement-breakpoint
ALTER TABLE "meeting_type_hosts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "meeting_type_hosts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "meeting_type_hosts" USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- Penghitung laju: bukan tabel tenant dan hanya berisi kunci ber-hash.
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_counters" TO jadwalin_app;
--> statement-breakpoint

-- ===== 3. Aktor 'public' (tamu tanpa akun) =====
CREATE FUNCTION is_public_actor() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.actor_kind', true), '') = 'public' $$;
--> statement-breakpoint
CREATE FUNCTION current_booking_token_hash() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.booking_token_hash', true), '') $$;
--> statement-breakpoint

-- Pemegang token booking (yang ada di emailnya) boleh membaca booking itu, jenis pertemuannya, dan nama workspace-nya.
CREATE POLICY booking_by_token ON "bookings" FOR SELECT
  USING (cancel_token_hash = current_booking_token_hash());
--> statement-breakpoint
CREATE POLICY booking_token_workspace ON "workspaces" FOR SELECT
  USING (id IN (SELECT workspace_id FROM bookings WHERE cancel_token_hash = current_booking_token_hash()));
--> statement-breakpoint
CREATE POLICY booking_token_meeting_type ON "meeting_types" FOR SELECT
  USING (id IN (SELECT meeting_type_id FROM bookings WHERE cancel_token_hash = current_booking_token_hash()));
--> statement-breakpoint

-- Tabel yang sama sekali tertutup bagi tamu.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_members', 'notification_outbox', 'notification_quota_usage', 'workspace_invitations', 'files', 'ticket_comments', 'ticket_attachments']
  LOOP
    EXECUTE format('CREATE POLICY public_denied ON %I AS RESTRICTIVE TO jadwalin_app USING (NOT is_public_actor())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- workspaces / meeting_type_hosts / availability: tamu dan klien boleh membaca (tenant_isolation tetap berlaku), tidak boleh menulis.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['meeting_type_hosts', 'availability_rules', 'availability_overrides']
  LOOP
    EXECUTE format('CREATE POLICY ext_no_insert ON %I AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_public_actor() AND NOT is_client_actor())', t);
    EXECUTE format('CREATE POLICY ext_no_update ON %I AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_public_actor() AND NOT is_client_actor())', t);
    EXECUTE format('CREATE POLICY ext_no_delete ON %I AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_public_actor() AND NOT is_client_actor())', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Ketersediaan sekarang dibaca klien (untuk memesan di portal): cabut penolakan total milik M4.
DROP POLICY client_denied ON "availability_rules";
--> statement-breakpoint
DROP POLICY client_denied ON "availability_overrides";
--> statement-breakpoint
CREATE POLICY public_no_insert ON "workspaces" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_public_actor());
--> statement-breakpoint
CREATE POLICY public_no_update ON "workspaces" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint
CREATE POLICY public_no_delete ON "workspaces" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint

-- meeting_types: tamu dan klien hanya melihat jenis yang aktif (atau yang dipakai booking-nya); tanpa tulis.
DROP POLICY client_meeting_types ON "meeting_types";
--> statement-breakpoint
CREATE POLICY ext_meeting_types_read ON "meeting_types" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING ((NOT is_public_actor() AND NOT is_client_actor()) OR active OR id IN (SELECT meeting_type_id FROM bookings));
--> statement-breakpoint
CREATE POLICY public_no_insert ON "meeting_types" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_public_actor());
--> statement-breakpoint
CREATE POLICY public_no_update ON "meeting_types" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint
CREATE POLICY public_no_delete ON "meeting_types" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint

-- bookings. Membaca booking aktif diperlukan untuk menghitung slot kosong; yang dibaca kode hanya rentang waktunya,
-- dan token tersimpan sebagai hash sehingga baris yang terbaca tidak bisa dipakai untuk mengelola booking orang lain.
DROP POLICY client_own_bookings ON "bookings";
--> statement-breakpoint
DROP POLICY client_no_insert ON "bookings";
--> statement-breakpoint
CREATE POLICY ext_bookings_read ON "bookings" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING ((NOT is_public_actor() AND NOT is_client_actor())
         OR status IN ('pending', 'confirmed')
         OR cancel_token_hash = current_booking_token_hash()
         OR (is_client_actor() AND id IN (SELECT booking_id FROM ticket_meetings)));
--> statement-breakpoint
CREATE POLICY client_bookings_insert ON "bookings" AS RESTRICTIVE FOR INSERT TO jadwalin_app
  WITH CHECK (NOT is_client_actor() OR (source = 'client_portal' AND client_id IN (SELECT id FROM workspace_clients)));
--> statement-breakpoint
CREATE POLICY public_bookings_insert ON "bookings" AS RESTRICTIVE FOR INSERT TO jadwalin_app
  WITH CHECK (NOT is_public_actor() OR source = 'public_link');
--> statement-breakpoint
CREATE POLICY public_bookings_update ON "bookings" AS RESTRICTIVE FOR UPDATE TO jadwalin_app
  USING (NOT is_public_actor() OR cancel_token_hash = current_booking_token_hash());
--> statement-breakpoint
CREATE POLICY public_no_delete ON "bookings" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint

-- ticket_meetings: klien boleh menautkan meeting ke tiket miliknya; tamu hanya menulis (tiket barunya), tidak membaca.
DROP POLICY client_no_insert ON "ticket_meetings";
--> statement-breakpoint
CREATE POLICY client_ticket_meetings_insert ON "ticket_meetings" AS RESTRICTIVE FOR INSERT TO jadwalin_app
  WITH CHECK (NOT is_client_actor() OR ticket_id IN (SELECT id FROM tickets));
--> statement-breakpoint
CREATE POLICY public_no_read ON "ticket_meetings" AS RESTRICTIVE FOR SELECT TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint
CREATE POLICY public_no_update ON "ticket_meetings" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint
CREATE POLICY public_no_delete ON "ticket_meetings" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint

-- tickets / ticket_events / audit_log: tamu hanya MENULIS atas nama anonim, tidak pernah membaca.
CREATE POLICY public_tickets_insert ON "tickets" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_public_actor() OR requester_user_id IS NULL);
--> statement-breakpoint
CREATE POLICY public_tickets_no_read ON "tickets" AS RESTRICTIVE FOR SELECT TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint
CREATE POLICY public_tickets_no_update ON "tickets" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint
CREATE POLICY public_tickets_no_delete ON "tickets" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint
CREATE POLICY public_events_insert ON "ticket_events" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_public_actor() OR actor_user_id IS NULL);
--> statement-breakpoint
CREATE POLICY public_events_no_read ON "ticket_events" AS RESTRICTIVE FOR SELECT TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint
CREATE POLICY public_audit_insert ON "audit_log" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_public_actor() OR actor_user_id IS NULL);
--> statement-breakpoint
CREATE POLICY public_audit_no_read ON "audit_log" AS RESTRICTIVE FOR SELECT TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint

-- workspace_clients: tamu boleh membuat dan melihat catatan klien TAMU (tanpa akun) saja.
CREATE POLICY public_clients_read ON "workspace_clients" AS RESTRICTIVE FOR SELECT TO jadwalin_app USING (NOT is_public_actor() OR user_id IS NULL);
--> statement-breakpoint
CREATE POLICY public_clients_insert ON "workspace_clients" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_public_actor() OR (user_id IS NULL AND blocked = false));
--> statement-breakpoint
CREATE POLICY public_clients_no_update ON "workspace_clients" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint
CREATE POLICY public_clients_no_delete ON "workspace_clients" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint

-- ===== 4. Role worker: klaim catatan tamu oleh pemilik email terverifikasi, dan pembatalan pengingat =====
-- Hanya kolom yang dibutuhkan yang boleh diubah, dan hanya pada baris yang memang belum bertuan.
GRANT SELECT ON "workspace_clients", "tickets" TO jadwalin_worker;
--> statement-breakpoint
GRANT UPDATE ("user_id") ON "workspace_clients" TO jadwalin_worker;
--> statement-breakpoint
GRANT UPDATE ("requester_user_id") ON "tickets" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_claim_clients_select ON "workspace_clients" FOR SELECT TO jadwalin_worker USING (user_id IS NULL OR user_id = current_user_id());
--> statement-breakpoint
CREATE POLICY worker_claim_clients_update ON "workspace_clients" FOR UPDATE TO jadwalin_worker USING (user_id IS NULL) WITH CHECK (user_id = current_user_id());
--> statement-breakpoint
CREATE POLICY worker_claim_tickets_select ON "tickets" FOR SELECT TO jadwalin_worker USING (requester_user_id IS NULL);
--> statement-breakpoint
CREATE POLICY worker_claim_tickets_update ON "tickets" FOR UPDATE TO jadwalin_worker USING (requester_user_id IS NULL) WITH CHECK (requester_user_id = current_user_id());
--> statement-breakpoint
-- Pembersihan penghitung laju kedaluwarsa oleh worker.
GRANT SELECT, DELETE ON "rate_counters" TO jadwalin_worker;
