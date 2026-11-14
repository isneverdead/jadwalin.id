-- Temuan uji: pembacaan pelanggan terlalu luas. Aktor tamu boleh membaca booking aktif (untuk slot), sehingga
-- "IN (SELECT ... FROM bookings)" tidak membatasi ke pemilik token. Persempit: tamu hanya lewat token booking miliknya,
-- klien hanya lewat catatan kliennya sendiri.
DROP POLICY ext_method_read ON "payment_methods";
--> statement-breakpoint
CREATE POLICY ext_method_read ON "payment_methods" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (
    (NOT is_client_actor() AND NOT is_public_actor())
    OR (active AND (
      (is_public_actor() AND workspace_id IN (SELECT workspace_id FROM bookings WHERE cancel_token_hash = current_booking_token_hash()))
      OR (is_client_actor() AND workspace_id IN (SELECT workspace_id FROM bookings WHERE client_id IN (SELECT id FROM workspace_clients)))
    ))
  );
--> statement-breakpoint
DROP POLICY ext_payment_read ON "payments";
--> statement-breakpoint
CREATE POLICY ext_payment_read ON "payments" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING (
    (NOT is_client_actor() AND NOT is_public_actor())
    OR (subject_type = 'booking' AND (
      (is_public_actor() AND subject_id IN (SELECT id FROM bookings WHERE cancel_token_hash = current_booking_token_hash()))
      OR (is_client_actor() AND subject_id IN (SELECT id FROM bookings WHERE client_id IN (SELECT id FROM workspace_clients)))
    ))
  );
--> statement-breakpoint
-- Bukti dibuat sebagai 'draft' saat unggahan diminta (mengikat berkas ke pembayaran), 'submitted' saat dikirim.
ALTER TABLE "payment_proofs" DROP CONSTRAINT "payment_proofs_status";
--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_status" CHECK ("status" IN ('draft', 'submitted', 'accepted', 'rejected'));
--> statement-breakpoint
ALTER TABLE "payment_proofs" ALTER COLUMN "status" SET DEFAULT 'draft';
