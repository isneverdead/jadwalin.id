-- Pada UPDATE, Postgres juga mengevaluasi policy SELECT terhadap baris BARU. Policy baca worker pada tickets hanya
-- mengizinkan baris tanpa pemilik, sehingga baris yang baru diklaim ditolak. Izinkan juga baris milik pengguna yang mengklaim.
DROP POLICY worker_claim_tickets_select ON "tickets";
--> statement-breakpoint
CREATE POLICY worker_claim_tickets_select ON "tickets" FOR SELECT TO jadwalin_worker
  USING (requester_user_id IS NULL OR requester_user_id = current_user_id());
