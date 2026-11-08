-- Temuan review independen (defense in depth), bukan celah yang terjangkau kode saat ini:
-- 1) Klien hanya boleh menautkan ke tiketnya booking yang MILIKNYA (sebelumnya hanya tiketnya yang diperiksa; booking
--    orang lain yang ditautkan akan ikut terbaca lewat policy baca booking).
DROP POLICY client_ticket_meetings_insert ON "ticket_meetings";
--> statement-breakpoint
CREATE POLICY client_ticket_meetings_insert ON "ticket_meetings" AS RESTRICTIVE FOR INSERT TO jadwalin_app
  WITH CHECK (NOT is_client_actor() OR (
    ticket_id IN (SELECT id FROM tickets)
    AND booking_id IN (SELECT id FROM bookings WHERE client_id IN (SELECT id FROM workspace_clients))));
--> statement-breakpoint
-- 2) Klien tidak boleh menulis jejak audit atas nama orang lain.
CREATE POLICY client_audit_insert ON "audit_log" AS RESTRICTIVE FOR INSERT TO jadwalin_app
  WITH CHECK (NOT is_client_actor() OR actor_user_id = current_user_id());
