-- ADR 0001. Tabel pembayaran: role aplikasi hanya MEMBACA (kecuali payment_accounts: staf boleh mendaftar akun, tidak boleh
-- mengesahkan KYC). Semua penulisan pembayaran lewat role worker (webhook, kedaluwarsa, rekonsiliasi, dan `asWorker` di dalam
-- transaksi pemesanan), sehingga klien/tamu tidak pernah punya hak tulis.
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_kyc" CHECK ("kyc_status" IN ('pending', 'verified', 'rejected'));
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amounts" CHECK ("amount_idr" > 0 AND "platform_fee_idr" >= 0 AND "platform_fee_idr" <= "amount_idr" AND "refunded_idr" >= 0 AND "refunded_idr" <= "amount_idr");
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_status" CHECK ("status" IN ('created', 'pending', 'paid', 'refund_pending', 'partially_refunded', 'refunded', 'expired', 'failed', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_source" CHECK ("source" IN ('webhook', 'api', 'reconcile', 'admin', 'system'));
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount" CHECK ("amount_idr" > 0);
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_status" CHECK ("status" IN ('requested', 'succeeded', 'failed'));
--> statement-breakpoint
ALTER TABLE "meeting_types" ADD CONSTRAINT "meeting_types_deposit" CHECK ("deposit_idr" >= 0);
--> statement-breakpoint
CREATE INDEX "payments_status_expires" ON "payments" ("status", "expires_at");
--> statement-breakpoint
CREATE INDEX "payment_events_payment" ON "payment_events" ("payment_id", "created_at");
--> statement-breakpoint

-- ===== RLS tenant =====
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_accounts', 'payments', 'payment_events', 'refunds']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ===== Hak role aplikasi (staf): baca saja; payment_accounts boleh didaftarkan dengan status 'pending' =====
GRANT SELECT ON "payments", "payment_events", "refunds" TO jadwalin_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "payment_accounts" TO jadwalin_app;
--> statement-breakpoint
CREATE POLICY kyc_pending_only ON "payment_accounts" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (kyc_status = 'pending');
--> statement-breakpoint

-- ===== Klien dan tamu =====
-- Akun pembayaran dan refund: tertutup total.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_accounts', 'refunds']
  LOOP
    EXECUTE format('CREATE POLICY client_denied ON %I AS RESTRICTIVE TO jadwalin_app USING (NOT is_client_actor())', t);
    EXECUTE format('CREATE POLICY public_denied ON %I AS RESTRICTIVE TO jadwalin_app USING (NOT is_public_actor())', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Pembayaran/riwayatnya: klien dan tamu hanya melihat milik booking yang sudah terlihat bagi mereka (RLS bookings berlaku di subquery).
CREATE POLICY ext_payment_read ON "payments" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING ((NOT is_client_actor() AND NOT is_public_actor()) OR (subject_type = 'booking' AND subject_id IN (SELECT id FROM bookings)));
--> statement-breakpoint
CREATE POLICY ext_payment_event_read ON "payment_events" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING ((NOT is_client_actor() AND NOT is_public_actor()) OR payment_id IN (SELECT id FROM payments));
--> statement-breakpoint

-- ===== Role worker =====
GRANT SELECT, INSERT, UPDATE ON "payments" TO jadwalin_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON "payment_events" TO jadwalin_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "refunds" TO jadwalin_worker;
--> statement-breakpoint
GRANT SELECT ON "payment_accounts" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_payments ON "payments" TO jadwalin_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY worker_payment_events_select ON "payment_events" FOR SELECT TO jadwalin_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_payment_events_insert ON "payment_events" FOR INSERT TO jadwalin_worker WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY worker_refunds ON "refunds" TO jadwalin_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY worker_payment_accounts ON "payment_accounts" FOR SELECT TO jadwalin_worker USING (true);
--> statement-breakpoint
-- Jejak transisi tidak dapat diubah/dihapus oleh role mana pun yang dipakai aplikasi.
REVOKE UPDATE, DELETE, TRUNCATE ON "payment_events" FROM jadwalin_app, jadwalin_worker;
--> statement-breakpoint

-- ===== webhook_inbox: bukan tabel tenant; hanya worker =====
ALTER TABLE "webhook_inbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "webhook_inbox" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "webhook_inbox" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_webhook_inbox ON "webhook_inbox" TO jadwalin_worker USING (true) WITH CHECK (true);
--> statement-breakpoint

-- ===== bookings: worker hanya boleh mengonfirmasi/membatalkan booking 'pending' (hasil pembayaran/kedaluwarsa) =====
GRANT SELECT (id, workspace_id, meeting_type_id, member_id, client_id, ticket_id, status, starts_at, ends_at) ON "bookings" TO jadwalin_worker;
--> statement-breakpoint
GRANT UPDATE (status) ON "bookings" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_bookings_select ON "bookings" FOR SELECT TO jadwalin_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_bookings_update ON "bookings" FOR UPDATE TO jadwalin_worker USING (status = 'pending') WITH CHECK (status IN ('confirmed', 'cancelled'));
