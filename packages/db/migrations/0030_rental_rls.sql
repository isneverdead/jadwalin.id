-- ADR 0003: sewa barang. Inti: resources + reservations (anti-bentrok di DB). Modul rental: rental_products + rental_orders.

-- ===== Batasan data =====
ALTER TABLE "resources" ADD CONSTRAINT "resources_units" CHECK ("units" BETWEEN 1 AND 50);
--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_status" CHECK ("status" IN ('pending', 'confirmed', 'active', 'completed', 'cancelled', 'rejected'));
--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_unit" CHECK ("unit_no" >= 1);
--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_range" CHECK (NOT isempty("during") AND lower("during") < upper("during"));
--> statement-breakpoint
-- Aturan #8: satu unit tidak boleh dipesan dua kali pada waktu yang bersinggungan (hanya status yang menahan unit).
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_no_overlap"
  EXCLUDE USING gist ("resource_id" WITH =, "unit_no" WITH =, "during" WITH &&) WHERE ("status" IN ('pending', 'confirmed', 'active'));
--> statement-breakpoint
ALTER TABLE "rental_products" ADD CONSTRAINT "rental_products_price" CHECK ("price_per_day_idr" >= 0 AND "price_per_day_idr" <= 1000000000 AND "deposit_idr" >= 0 AND "deposit_idr" <= 1000000000);
--> statement-breakpoint
ALTER TABLE "rental_orders" ADD CONSTRAINT "rental_orders_span" CHECK ("days" >= 1 AND "end_date" >= "start_date" AND "total_idr" >= 0);
--> statement-breakpoint

-- ===== RLS tenant =====
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['resources', 'reservations', 'rental_products', 'rental_orders']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id())', t);
    -- Klien terdaftar (portal) tidak memakai sewa: tertutup total.
    EXECUTE format('CREATE POLICY client_denied ON %I AS RESTRICTIVE TO jadwalin_app USING (NOT is_client_actor())', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "resources", "reservations", "rental_products", "rental_orders" TO jadwalin_app;
--> statement-breakpoint

-- ===== Tamu tanpa akun (aktor 'public') =====
-- Katalog: hanya produk/sumber daya aktif, tanpa tulis.
CREATE POLICY public_resources_read ON "resources" AS RESTRICTIVE FOR SELECT TO jadwalin_app USING (NOT is_public_actor() OR active);
--> statement-breakpoint
CREATE POLICY public_products_read ON "rental_products" AS RESTRICTIVE FOR SELECT TO jadwalin_app USING (NOT is_public_actor() OR active);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['resources', 'rental_products']
  LOOP
    EXECUTE format('CREATE POLICY public_no_insert ON %I AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_public_actor())', t);
    EXECUTE format('CREATE POLICY public_no_update ON %I AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_public_actor())', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Reservasi: membaca yang aktif diperlukan untuk menghitung ketersediaan (token tersimpan sebagai hash); membuat hanya 'pending';
-- mengubah hanya milik token sendiri dan hanya menjadi 'cancelled'.
CREATE POLICY public_reservations_read ON "reservations" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (NOT is_public_actor() OR status IN ('pending', 'confirmed', 'active') OR token_hash = current_booking_token_hash());
--> statement-breakpoint
CREATE POLICY public_reservations_insert ON "reservations" AS RESTRICTIVE FOR INSERT TO jadwalin_app
  WITH CHECK (NOT is_public_actor() OR status = 'pending');
--> statement-breakpoint
CREATE POLICY public_reservations_update ON "reservations" AS RESTRICTIVE FOR UPDATE TO jadwalin_app
  USING (NOT is_public_actor() OR token_hash = current_booking_token_hash())
  WITH CHECK (NOT is_public_actor() OR (token_hash = current_booking_token_hash() AND status = 'cancelled'));
--> statement-breakpoint
-- Pesanan: tamu hanya membuat dan membaca pesanannya sendiri (lewat token reservasi).
CREATE POLICY public_orders_read ON "rental_orders" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (NOT is_public_actor() OR reservation_id IN (SELECT id FROM reservations WHERE token_hash = current_booking_token_hash()));
--> statement-breakpoint
CREATE POLICY public_orders_no_update ON "rental_orders" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint
-- Foto produk: tamu boleh membaca baris berkas yang dipakai produk aktif (untuk menandatangani URL tampil); tanpa tulis.
DROP POLICY public_denied ON "files";
--> statement-breakpoint
CREATE POLICY public_files_read ON "files" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (NOT is_public_actor() OR id IN (SELECT image_file_id FROM rental_products WHERE active AND image_file_id IS NOT NULL));
--> statement-breakpoint
CREATE POLICY public_files_no_insert ON "files" AS RESTRICTIVE FOR INSERT TO jadwalin_app WITH CHECK (NOT is_public_actor());
--> statement-breakpoint
CREATE POLICY public_files_no_update ON "files" AS RESTRICTIVE FOR UPDATE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint
CREATE POLICY public_files_no_delete ON "files" AS RESTRICTIVE FOR DELETE TO jadwalin_app USING (NOT is_public_actor());
