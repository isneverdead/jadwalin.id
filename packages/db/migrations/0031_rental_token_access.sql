-- Pemegang token sewa (yang ada di emailnya) membaca pesanannya TANPA mengetahui slug: sama dengan pola token booking (0011).
CREATE POLICY reservation_by_token ON "reservations" FOR SELECT
  USING (token_hash = current_booking_token_hash());
--> statement-breakpoint
CREATE POLICY reservation_token_workspace ON "workspaces" FOR SELECT
  USING (id IN (SELECT workspace_id FROM reservations WHERE token_hash = current_booking_token_hash()));
--> statement-breakpoint
CREATE POLICY reservation_token_order ON "rental_orders" FOR SELECT
  USING (reservation_id IN (SELECT id FROM reservations WHERE token_hash = current_booking_token_hash()));
--> statement-breakpoint
CREATE POLICY reservation_token_product ON "rental_products" FOR SELECT
  USING (id IN (SELECT product_id FROM rental_orders));
--> statement-breakpoint
-- Produk yang sudah dinonaktifkan tetap terbaca oleh pemilik pesanannya (lewat rental_orders yang dibatasi token).
DROP POLICY public_products_read ON "rental_products";
--> statement-breakpoint
CREATE POLICY public_products_read ON "rental_products" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (NOT is_public_actor() OR active OR id IN (SELECT product_id FROM rental_orders));
