-- Konteks user (app.user_id) untuk kebutuhan lintas-workspace yang sah:
-- daftar workspace milik saya, dan portal klien "Jadwal saya". Tetap gagal tertutup bila tidak diset.
CREATE FUNCTION current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE POLICY own_membership ON "workspace_members" FOR SELECT
  USING (user_id = current_user_id());
--> statement-breakpoint
CREATE POLICY own_client_record ON "workspace_clients" FOR SELECT
  USING (user_id = current_user_id());
--> statement-breakpoint
CREATE POLICY member_sees_workspace ON "workspaces" FOR SELECT
  USING (id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_user_id()));
--> statement-breakpoint
CREATE POLICY client_sees_workspace ON "workspaces" FOR SELECT
  USING (id IN (SELECT workspace_id FROM workspace_clients WHERE user_id = current_user_id()));
--> statement-breakpoint

-- users dikelola Better Auth (pemilik tabel, melewati RLS). Role aplikasi hanya boleh MEMBACA
-- diri sendiri dan sesama anggota workspace aktif; tidak boleh menulis.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY visible_users ON "users" FOR SELECT
  USING (id = current_user_id() OR id IN (SELECT user_id FROM workspace_members));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "users" FROM jadwalin_app;
--> statement-breakpoint

-- Cari id user dari email (untuk menambah anggota). Hanya mengembalikan id; pemanggil wajib admin/owner (dicek di core).
CREATE FUNCTION find_user_id_by_email(p_email text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT id FROM users WHERE lower(email) = lower(p_email) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_user_id_by_email(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_user_id_by_email(text) TO jadwalin_app;
