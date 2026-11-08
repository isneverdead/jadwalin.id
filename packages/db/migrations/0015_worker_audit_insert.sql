-- Kejadian keamanan tingkat platform (masuk, gagal masuk, reset sandi) tidak milik workspace mana pun:
-- ditulis oleh role worker dengan workspace_id NULL. Hanya INSERT; tidak ada baca/ubah/hapus (append-only).
GRANT INSERT ON "audit_log" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_audit_insert ON "audit_log" FOR INSERT TO jadwalin_worker WITH CHECK (workspace_id IS NULL);
