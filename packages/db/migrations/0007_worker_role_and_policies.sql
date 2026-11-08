-- Role worker: dipakai proses latar (apps/worker) yang memang lintas-tenant, tapi hanya untuk tabel
-- yang dibutuhkannya. Dengan policy eksplisit ini RLS tetap FORCE dan tidak butuh superuser/BYPASSRLS.
-- Produksi: GRANT jadwalin_worker, jadwalin_app TO <role login aplikasi>.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jadwalin_worker') THEN
    CREATE ROLE jadwalin_worker NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO jadwalin_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "notification_outbox" TO jadwalin_worker;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "files" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_outbox ON "notification_outbox" TO jadwalin_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY worker_files_select ON "files" FOR SELECT TO jadwalin_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_files_update ON "files" FOR UPDATE TO jadwalin_worker USING (true) WITH CHECK (true);
--> statement-breakpoint

-- Tabel tenant baru: grant eksplisit + RLS (aturan di CLAUDE.md).
GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_quota_usage" TO jadwalin_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_invitations" TO jadwalin_app;
--> statement-breakpoint
ALTER TABLE "notification_quota_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification_quota_usage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "notification_quota_usage" USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
ALTER TABLE "workspace_invitations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_invitations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "workspace_invitations" USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- Penerima undangan (belum anggota) menemukan undangannya lewat hash token yang ia pegang.
CREATE POLICY invite_by_token ON "workspace_invitations" FOR SELECT
  USING (token_hash = nullif(current_setting('app.invite_token_hash', true), ''));
--> statement-breakpoint
-- Penerima undangan boleh melihat nama workspace pengundang (hanya selama memegang token valid).
CREATE POLICY invited_sees_workspace ON "workspaces" FOR SELECT
  USING (id IN (SELECT workspace_id FROM workspace_invitations WHERE token_hash = nullif(current_setting('app.invite_token_hash', true), '')));
--> statement-breakpoint
-- Satu undangan aktif per email per workspace.
CREATE UNIQUE INDEX "invitations_one_active" ON "workspace_invitations" ("workspace_id", lower("email"))
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "notification_quota_usage" ADD CONSTRAINT "quota_valid" CHECK ("used" >= 0 AND "limit_count" >= 0);
--> statement-breakpoint
CREATE INDEX "files_status_created" ON "files" ("status", "created_at");
--> statement-breakpoint

-- Menambah anggota lewat email membuka enumerasi akun. Diganti undangan berbasis token.
DROP FUNCTION IF EXISTS find_user_id_by_email(text);
