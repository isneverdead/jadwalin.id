-- ADR 0002: pembayaran manual. Status baru 'awaiting_verification'.
ALTER TABLE "payments" DROP CONSTRAINT "payments_status";
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_status" CHECK ("status" IN ('created', 'pending', 'awaiting_verification', 'paid', 'refund_pending', 'partially_refunded', 'refunded', 'expired', 'failed', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_kind" CHECK ("kind" IN ('bank_transfer', 'qris', 'ewallet', 'other'));
--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_status" CHECK ("status" IN ('submitted', 'accepted', 'rejected'));
--> statement-breakpoint
CREATE INDEX "payment_methods_ws" ON "payment_methods" ("workspace_id", "sort_order");
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_methods', 'payment_proofs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Staf (via core, admin ke atas) mengelola metode bayar; bukti hanya dibaca role aplikasi (penulisan lewat worker).
GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_methods" TO jadwalin_app;
--> statement-breakpoint
GRANT SELECT ON "payment_proofs" TO jadwalin_app;
--> statement-breakpoint

-- Pelanggan (klien terdaftar / tamu): metode bayar hanya terbaca bila ia punya booking di workspace itu (RLS bookings berlaku
-- di subquery) dan metodenya aktif; tidak boleh menulis. Bukti: tertutup total (diakses lewat fungsi core + worker).
CREATE POLICY ext_method_read ON "payment_methods" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING ((NOT is_client_actor() AND NOT is_public_actor()) OR (active AND workspace_id IN (SELECT workspace_id FROM bookings)));
--> statement-breakpoint
CREATE POLICY ext_method_no_insert ON "payment_methods" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_public_actor() AND NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY ext_method_no_update ON "payment_methods" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_public_actor() AND NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY ext_method_no_delete ON "payment_methods" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_public_actor() AND NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY client_denied ON "payment_proofs" AS RESTRICTIVE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY public_denied ON "payment_proofs" AS RESTRICTIVE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint

-- Worker (ADR 0002): membaca metode bayar, menulis bukti, dan membuat berkas bukti milik pelanggan tanpa akun (uploaded_by NULL).
GRANT SELECT ON "payment_methods" TO jadwalin_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "payment_proofs" TO jadwalin_worker;
--> statement-breakpoint
GRANT INSERT ON "files" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_payment_methods ON "payment_methods" FOR SELECT TO jadwalin_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_payment_proofs ON "payment_proofs" TO jadwalin_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY worker_files_insert ON "files" FOR INSERT TO jadwalin_worker WITH CHECK (uploaded_by IS NULL);
