-- ===== Penghitung nomor tiket per workspace (tabel tenant) =====
GRANT SELECT, INSERT, UPDATE ON "ticket_counters" TO jadwalin_app;
--> statement-breakpoint
ALTER TABLE "ticket_counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ticket_counters" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "ticket_counters" USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_clients_one_per_user" ON "workspace_clients" ("workspace_id", "user_id") WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "ticket_comments_ticket" ON "ticket_comments" ("ticket_id", "created_at");
--> statement-breakpoint
CREATE INDEX "ticket_events_ticket" ON "ticket_events" ("ticket_id", "created_at");
--> statement-breakpoint
CREATE INDEX "tickets_ws_assignee" ON "tickets" ("workspace_id", "assignee_member_id");
--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_author_kind" CHECK ("author_kind" IN ('client', 'staff'));
--> statement-breakpoint
-- Riwayat dan komentar tidak bisa diubah/dihapus oleh role aplikasi (integritas jejak).
REVOKE UPDATE, DELETE ON "ticket_events" FROM jadwalin_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "ticket_comments" FROM jadwalin_app;
--> statement-breakpoint

-- ===== Mode aktor klien =====
-- Klien bukan anggota workspace. Mereka masuk lewat konteks tenant dengan app.actor_kind = 'client'.
-- Policy RESTRICTIVE di bawah di-AND dengan tenant_isolation, sehingga walau kode salah, SQL tetap
-- membatasi klien pada tiket miliknya sendiri. Semua policy ini hanya untuk jadwalin_app: role worker
-- (yang kadang dialihkan di tengah transaksi klien untuk mengantre email) tidak terkena.
CREATE FUNCTION is_client_actor() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.actor_kind', true), '') = 'client' $$;
--> statement-breakpoint

-- Tabel yang sama sekali tertutup bagi klien.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_members', 'availability_rules', 'availability_overrides', 'notification_outbox', 'notification_quota_usage', 'workspace_invitations']
  LOOP
    EXECUTE format('CREATE POLICY client_denied ON %I AS RESTRICTIVE TO jadwalin_app USING (NOT is_client_actor())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- audit_log: klien boleh menulis jejaknya sendiri, tidak boleh membaca.
CREATE POLICY client_no_read ON "audit_log" AS RESTRICTIVE FOR SELECT TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint

-- workspaces: klien tidak boleh mengubah.
CREATE POLICY client_no_insert ON "workspaces" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY client_no_update ON "workspaces" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY client_no_delete ON "workspaces" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint

-- workspace_clients: hanya baris sendiri; boleh membuat baris sendiri (tidak diblokir); tidak boleh mengubah/menghapus.
CREATE POLICY client_own_row ON "workspace_clients" AS RESTRICTIVE FOR SELECT TO jadwalin_app USING (NOT is_client_actor() OR user_id = current_user_id());
--> statement-breakpoint
CREATE POLICY client_insert_self ON "workspace_clients" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_client_actor() OR (user_id = current_user_id() AND blocked = false));
--> statement-breakpoint
CREATE POLICY client_no_update ON "workspace_clients" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY client_no_delete ON "workspace_clients" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint

-- tickets: hanya milik sendiri. Klien boleh membuat tiket atas namanya sendiri dan mengubahnya (mis. menutup);
-- pembatasan kolom (prioritas, penugasan) ada di lapisan modul, tetapi baris orang lain tak pernah terjangkau.
CREATE POLICY client_own_tickets ON "tickets" AS RESTRICTIVE TO jadwalin_app USING (NOT is_client_actor() OR requester_user_id = current_user_id());
--> statement-breakpoint
CREATE POLICY client_no_delete ON "tickets" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint

-- ticket_comments: hanya komentar publik pada tiket miliknya; menulis hanya atas nama sendiri sebagai 'client'.
CREATE POLICY client_public_comments ON "ticket_comments" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (NOT is_client_actor() OR (internal = false AND ticket_id IN (SELECT id FROM tickets)));
--> statement-breakpoint
CREATE POLICY client_comment_insert ON "ticket_comments" AS RESTRICTIVE FOR INSERT TO jadwalin_app
  WITH CHECK (NOT is_client_actor() OR (internal = false AND author_kind = 'client' AND author_user_id = current_user_id() AND ticket_id IN (SELECT id FROM tickets)));
--> statement-breakpoint

-- ticket_attachments: hanya yang ditandai terlihat klien pada tiket miliknya.
CREATE POLICY client_visible_attachments ON "ticket_attachments" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (NOT is_client_actor() OR (client_visible AND ticket_id IN (SELECT id FROM tickets)));
--> statement-breakpoint
CREATE POLICY client_attachment_insert ON "ticket_attachments" AS RESTRICTIVE FOR INSERT TO jadwalin_app
  WITH CHECK (NOT is_client_actor() OR (client_visible AND uploaded_by = current_user_id() AND ticket_id IN (SELECT id FROM tickets)));
--> statement-breakpoint
CREATE POLICY client_no_update ON "ticket_attachments" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY client_no_delete ON "ticket_attachments" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint

-- ticket_events: hanya yang terlihat klien pada tiket miliknya; menulis hanya atas nama sendiri.
CREATE POLICY client_visible_events ON "ticket_events" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (NOT is_client_actor() OR (client_visible AND ticket_id IN (SELECT id FROM tickets)));
--> statement-breakpoint
CREATE POLICY client_event_insert ON "ticket_events" AS RESTRICTIVE FOR INSERT TO jadwalin_app
  WITH CHECK (NOT is_client_actor() OR (actor_user_id = current_user_id() AND ticket_id IN (SELECT id FROM tickets)));
--> statement-breakpoint

-- ticket_meetings, bookings, meeting_types: hanya yang terkait tiket milik klien; tanpa tulis.
CREATE POLICY client_own_ticket_meetings ON "ticket_meetings" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (NOT is_client_actor() OR ticket_id IN (SELECT id FROM tickets));
--> statement-breakpoint
CREATE POLICY client_no_insert ON "ticket_meetings" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY client_no_update ON "ticket_meetings" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY client_no_delete ON "ticket_meetings" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY client_own_bookings ON "bookings" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (NOT is_client_actor() OR id IN (SELECT booking_id FROM ticket_meetings));
--> statement-breakpoint
CREATE POLICY client_no_insert ON "bookings" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY client_no_update ON "bookings" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY client_no_delete ON "bookings" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY client_meeting_types ON "meeting_types" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (NOT is_client_actor() OR id IN (SELECT meeting_type_id FROM bookings));
--> statement-breakpoint
CREATE POLICY client_no_insert ON "meeting_types" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY client_no_update ON "meeting_types" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY client_no_delete ON "meeting_types" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint

-- files: hanya yang diunggahnya sendiri atau yang terlampir pada tiket miliknya (dan terlihat klien).
CREATE POLICY client_files_select ON "files" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (NOT is_client_actor() OR uploaded_by = current_user_id() OR id IN (SELECT file_id FROM ticket_attachments));
--> statement-breakpoint
CREATE POLICY client_files_insert ON "files" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_client_actor() OR uploaded_by = current_user_id());
--> statement-breakpoint
CREATE POLICY client_files_update ON "files" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_client_actor() OR uploaded_by = current_user_id());
--> statement-breakpoint
CREATE POLICY client_no_delete ON "files" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint

-- ===== Portal publik: cari workspace lewat slug (nama saja yang dibutuhkan) =====
CREATE POLICY public_slug_workspace ON "workspaces" FOR SELECT
  USING (slug = nullif(current_setting('app.public_slug', true), ''));
--> statement-breakpoint

-- ===== Role worker: boleh membaca anggota/pengguna/workspace dan memakai kuota, agar email notifikasi tiket
-- bisa diantre di dalam transaksi yang sama (peralihan role sementara) ke staf yang berhak. =====
GRANT SELECT ON "workspace_members", "workspaces", "users" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_read ON "workspace_members" FOR SELECT TO jadwalin_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_read ON "workspaces" FOR SELECT TO jadwalin_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_read ON "users" FOR SELECT TO jadwalin_worker USING (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "notification_quota_usage" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_quota ON "notification_quota_usage" TO jadwalin_worker USING (true) WITH CHECK (true);
