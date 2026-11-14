CREATE TABLE "subscription_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"plan" text NOT NULL,
	"months" integer NOT NULL,
	"amount_idr" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"proof_file_id" uuid,
	"proof_note" text,
	"submitted_at" timestamp with time zone,
	"reject_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan" text DEFAULT 'gratis' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_proof_file_id_files_id_fk" FOREIGN KEY ("proof_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_invoices_ws" ON "subscription_invoices" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "subscription_invoices_status" ON "subscription_invoices" USING btree ("status");--> statement-breakpoint

-- ADR 0005: paket langganan, tagihan upgrade (transfer manual ke rekening platform), dan superadmin platform.
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_plan" CHECK ("plan" IN ('gratis', 'pro', 'bisnis'));
--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_plan" CHECK ("plan" IN ('pro', 'bisnis'));
--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_months" CHECK ("months" IN (1, 12));
--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_status" CHECK ("status" IN ('pending', 'awaiting_verification', 'paid', 'rejected', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_amount" CHECK ("amount_idr" > 0);
--> statement-breakpoint
-- Satu tagihan terbuka per usaha.
CREATE UNIQUE INDEX "subscription_invoices_one_open" ON "subscription_invoices" ("workspace_id") WHERE "status" IN ('pending', 'awaiting_verification');
--> statement-breakpoint

ALTER TABLE "subscription_invoices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_invoices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "subscription_invoices" USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
--> statement-breakpoint
-- Usaha hanya MEMBACA tagihannya; menulis lewat fungsi core + role worker (status tidak boleh diubah usaha sendiri).
GRANT SELECT ON "subscription_invoices" TO jadwalin_app;
--> statement-breakpoint
CREATE POLICY client_denied ON "subscription_invoices" AS RESTRICTIVE TO jadwalin_app USING (NOT is_client_actor());
--> statement-breakpoint
CREATE POLICY public_denied ON "subscription_invoices" AS RESTRICTIVE TO jadwalin_app USING (NOT is_public_actor());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "subscription_invoices" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_subscription_invoices ON "subscription_invoices" TO jadwalin_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Superadmin (hanya lewat core, setelah allowlist email terverifikasi): mengubah paket usaha dan menangguhkan akun.
GRANT UPDATE ("plan", "plan_until") ON "workspaces" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_workspaces_plan ON "workspaces" FOR UPDATE TO jadwalin_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT UPDATE ("suspended_at") ON "users" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_users_suspend ON "users" FOR UPDATE TO jadwalin_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Defense in depth: role aplikasi TIDAK boleh mengubah paket usaha (plan, plan_until) walau kode core keliru; hanya worker.
REVOKE UPDATE ON "workspaces" FROM jadwalin_app;
--> statement-breakpoint
GRANT UPDATE ("slug", "name", "timezone", "features", "deleted_at", "reschedule_mode", "change_min_hours", "contact_phone") ON "workspaces" TO jadwalin_app;
