-- Worker perlu membaca alamat email semua klien (termasuk yang terdaftar) untuk mengantre email booking
-- saat aksi dilakukan tamu/klien. Pengubahan tetap hanya untuk klaim catatan tamu (migrasi 0011).
DROP POLICY worker_claim_clients_select ON "workspace_clients";
--> statement-breakpoint
CREATE POLICY worker_clients_read ON "workspace_clients" FOR SELECT TO jadwalin_worker USING (true);
