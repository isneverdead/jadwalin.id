-- 0016 membuat siklus policy: ticket_meetings(INSERT) -> bookings(SELECT) -> ticket_meetings(SELECT), yang ditolak
-- Postgres ("infinite recursion detected in policy"). Putus siklus: klien membaca booking MILIKNYA lewat client_id
-- langsung (maknanya sama dengan "booking yang tertaut ke tiketnya"), tanpa merujuk ticket_meetings.
DROP POLICY ext_bookings_read ON "bookings";
--> statement-breakpoint
CREATE POLICY ext_bookings_read ON "bookings" AS RESTRICTIVE FOR SELECT TO jadwalin_app
  USING ((NOT is_public_actor() AND NOT is_client_actor())
         OR status IN ('pending', 'confirmed')
         OR cancel_token_hash = current_booking_token_hash()
         OR (is_client_actor() AND client_id IN (SELECT id FROM workspace_clients)));
