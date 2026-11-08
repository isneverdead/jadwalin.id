-- Anti-bentrok jadwal (aturan #8): satu anggota tidak bisa punya dua booking aktif yang tumpang tindih.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist ("member_id" WITH =, "during" WITH &&)
  WHERE ("status" IN ('pending', 'confirmed'));
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_during_valid" CHECK (NOT isempty("during") AND lower_inf("during") = false AND upper_inf("during") = false);
--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_valid" CHECK ("weekday" BETWEEN 0 AND 6 AND "end_time" > "start_time");
--> statement-breakpoint
ALTER TABLE "meeting_types" ADD CONSTRAINT "meeting_types_valid" CHECK ("duration_min" > 0 AND "buffer_before_min" >= 0 AND "buffer_after_min" >= 0);
--> statement-breakpoint

-- Role aplikasi: BUKAN superuser dan bukan pemilik tabel, sehingga RLS berlaku (aturan #9).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jadwalin_app') THEN
    CREATE ROLE jadwalin_app NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO jadwalin_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO jadwalin_app;
--> statement-breakpoint
-- Log audit append-only.
REVOKE UPDATE, DELETE ON "audit_log" FROM jadwalin_app;
--> statement-breakpoint

-- Row-Level Security: tanpa app.workspace_id, tidak ada baris yang terlihat (gagal tertutup).
CREATE FUNCTION current_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_members', 'workspace_clients', 'meeting_types', 'availability_rules',
    'availability_overrides', 'tickets', 'bookings', 'files', 'notification_outbox',
    'ticket_comments', 'ticket_attachments', 'ticket_events', 'ticket_meetings', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id())',
      t
    );
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "workspaces" USING (id = current_workspace_id()) WITH CHECK (id = current_workspace_id());
