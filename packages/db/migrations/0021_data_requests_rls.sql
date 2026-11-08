-- data_requests: milik pengguna (bukan tenant). Pengguna hanya melihat dan membuat permintaannya sendiri; status
-- hanya diubah operator (superuser/pemilik) lewat prosedur di docs/runbook.md, bukan oleh role aplikasi.
GRANT SELECT, INSERT ON "data_requests" TO jadwalin_app;
--> statement-breakpoint
ALTER TABLE "data_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "data_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_requests ON "data_requests" USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id() AND status = 'pending');
--> statement-breakpoint
CREATE UNIQUE INDEX "data_requests_one_pending" ON "data_requests" ("user_id", "kind") WHERE "status" = 'pending';
