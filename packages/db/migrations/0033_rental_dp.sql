ALTER TABLE "rental_orders" ADD COLUMN "dp_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rental_products" ADD COLUMN "dp_percent" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "rental_products" ADD CONSTRAINT "rental_products_dp_percent" CHECK ("dp_percent" BETWEEN 0 AND 100);
--> statement-breakpoint
ALTER TABLE "rental_orders" ADD CONSTRAINT "rental_orders_dp" CHECK ("dp_idr" >= 0 AND "dp_idr" <= "total_idr");
--> statement-breakpoint
-- DP sewa memakai pembayaran manual yang sama (ADR 0002): subjek 'reservation'. Pelanggan membacanya lewat token reservasi.
DROP POLICY ext_payment_read ON "payments";
--> statement-breakpoint
CREATE POLICY ext_payment_read ON "payments" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (
    (NOT is_client_actor() AND NOT is_public_actor())
    OR (subject_type = 'booking' AND (
      (is_public_actor() AND subject_id IN (SELECT id FROM bookings WHERE cancel_token_hash = current_booking_token_hash()))
      OR (is_client_actor() AND subject_id IN (SELECT id FROM bookings WHERE client_id IN (SELECT id FROM workspace_clients)))
    ))
    OR (subject_type = 'reservation' AND is_public_actor() AND subject_id IN (SELECT id FROM reservations WHERE token_hash = current_booking_token_hash()))
  );
--> statement-breakpoint
DROP POLICY ext_method_read ON "payment_methods";
--> statement-breakpoint
CREATE POLICY ext_method_read ON "payment_methods" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (
    (NOT is_client_actor() AND NOT is_public_actor())
    OR (active AND (
      (is_public_actor() AND (
        workspace_id IN (SELECT workspace_id FROM bookings WHERE cancel_token_hash = current_booking_token_hash())
        OR workspace_id IN (SELECT workspace_id FROM reservations WHERE token_hash = current_booking_token_hash())
      ))
      OR (is_client_actor() AND workspace_id IN (SELECT workspace_id FROM bookings WHERE client_id IN (SELECT id FROM workspace_clients)))
    ))
  );
--> statement-breakpoint
-- Worker (peralihan sementara di transaksi pembayaran) boleh mengonfirmasi/melepas reservasi yang menunggu DP: hanya kolom status, hanya dari 'pending'.
GRANT SELECT (id, workspace_id, resource_id, client_id, status, during) ON "reservations" TO jadwalin_worker;
--> statement-breakpoint
GRANT UPDATE (status) ON "reservations" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_reservations_select ON "reservations" FOR SELECT TO jadwalin_worker USING (true);
--> statement-breakpoint
CREATE POLICY worker_reservations_update ON "reservations" FOR UPDATE TO jadwalin_worker USING (status = 'pending') WITH CHECK (status IN ('confirmed', 'cancelled'));
--> statement-breakpoint
GRANT SELECT (id, workspace_id, name) ON "resources" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_resources_select ON "resources" FOR SELECT TO jadwalin_worker USING (true);
