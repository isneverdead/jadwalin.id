-- Model bisnis 2026-11-15: paket perorangan/studio/lapangan/klinik + biaya setup sekali bayar (menggantikan pro/bisnis).
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_plan";--> statement-breakpoint
ALTER TABLE "subscription_invoices" DROP CONSTRAINT "subscription_invoices_plan";--> statement-breakpoint
UPDATE "workspaces" SET "plan" = 'studio' WHERE "plan" = 'pro';--> statement-breakpoint
UPDATE "workspaces" SET "plan" = 'lapangan' WHERE "plan" = 'bisnis';--> statement-breakpoint
UPDATE "subscription_invoices" SET "plan" = 'studio' WHERE "plan" = 'pro';--> statement-breakpoint
UPDATE "subscription_invoices" SET "plan" = 'lapangan' WHERE "plan" = 'bisnis';--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_plan" CHECK ("plan" IN ('gratis', 'perorangan', 'studio', 'lapangan', 'klinik'));--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_plan" CHECK ("plan" IN ('perorangan', 'studio', 'lapangan', 'klinik'));--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD COLUMN "setup_idr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_setup" CHECK ("setup_idr" >= 0 AND "setup_idr" < "amount_idr" + 1);
