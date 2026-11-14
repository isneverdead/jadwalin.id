CREATE TABLE "booking_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"reason" text,
	"refund_account" text,
	"new_starts_at" timestamp with time zone,
	"refund_amount_idr" bigint,
	"decision_note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"refund_file_id" uuid,
	"refunded_at" timestamp with time zone,
	"customer_ack" text,
	"customer_ack_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "reschedule_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "change_min_hours" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_refund_file_id_files_id_fk" FOREIGN KEY ("refund_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_requests_ws_status" ON "booking_requests" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "booking_requests_booking" ON "booking_requests" USING btree ("booking_id");--> statement-breakpoint

-- ADR 0004: pembatalan/ubah jadwal dengan persetujuan, refund manual bertanda bukti, tamu tanpa email.
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_reschedule_mode" CHECK ("reschedule_mode" IN ('auto', 'approval'));
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_change_min_hours" CHECK ("change_min_hours" BETWEEN 0 AND 720);
--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_kind" CHECK ("kind" IN ('cancel', 'reschedule'));
--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_status" CHECK ("status" IN ('requested', 'approved', 'rejected', 'completed', 'withdrawn'));
--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_ack" CHECK ("customer_ack" IS NULL OR "customer_ack" IN ('received', 'not_received'));
--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_refund_nonneg" CHECK ("refund_amount_idr" IS NULL OR "refund_amount_idr" >= 0);
--> statement-breakpoint
-- Satu permintaan aktif (requested/approved) per booking.
CREATE UNIQUE INDEX "booking_requests_one_open" ON "booking_requests" ("booking_id") WHERE "status" IN ('requested', 'approved');
--> statement-breakpoint
-- Tamu tanpa email diidentifikasi lewat nomor HP (catatan klien tamu, idempoten terhadap pemesanan serentak).
CREATE UNIQUE INDEX "workspace_clients_guest_phone" ON "workspace_clients" ("workspace_id", "phone") WHERE "user_id" IS NULL AND "email" IS NULL AND "phone" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "booking_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "booking_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "booking_requests" USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- Staf (via core, withWorkspace) membaca dan memutuskan; pembuatan hanya lewat worker (permintaan pelanggan).
GRANT SELECT, UPDATE ON "booking_requests" TO jadwalin_app;
--> statement-breakpoint
-- Pelanggan (klien terdaftar maupun tamu) TIDAK menyentuh tabel ini langsung; semua lewat fungsi core + role worker.
CREATE POLICY client_denied ON "booking_requests" AS RESTRICTIVE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY public_denied ON "booking_requests" AS RESTRICTIVE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "booking_requests" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_booking_requests ON "booking_requests" TO jadwalin_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Worker: memutar token kelola booking (pemulihan tautan lewat kode booking + nomor HP) dan membaca pengaturan perubahan usaha.
GRANT UPDATE ("cancel_token_hash") ON "bookings" TO jadwalin_worker;
--> statement-breakpoint
GRANT SELECT ("reschedule_mode", "change_min_hours") ON "workspaces" TO jadwalin_worker;
