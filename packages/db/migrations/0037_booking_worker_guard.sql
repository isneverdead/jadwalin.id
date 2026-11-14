-- ADR 0004 (koreksi 0036): pemulihan tautan harus bisa memutar token booking APA PUN statusnya (booking yang sudah
-- dibatalkan/direfund pun perlu dibuka pelanggan untuk melihat status refund). Policy 0036 terlalu sempit. Pengganti:
-- policy longgar untuk baris, tetapi aturan lama "worker hanya mengonfirmasi/membatalkan booking pending" dipindahkan ke
-- trigger supaya hak status role worker TIDAK melebar.
DROP POLICY worker_bookings_rotate_token ON "bookings";
--> statement-breakpoint
CREATE POLICY worker_bookings_rotate_token ON "bookings" FOR UPDATE TO jadwalin_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION guard_worker_booking_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'jadwalin_worker'
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending' AND NEW.status IN ('confirmed', 'cancelled')) THEN
    RAISE EXCEPTION 'role worker hanya boleh mengonfirmasi atau membatalkan booking berstatus pending';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER bookings_worker_status_guard BEFORE UPDATE OF status ON "bookings" FOR EACH ROW EXECUTE FUNCTION guard_worker_booking_status();
