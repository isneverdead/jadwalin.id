ALTER TABLE "bookings" DROP CONSTRAINT "bookings_cancel_token_unique";--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "cancel_token_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "starts_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "ends_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" DROP COLUMN "cancel_token";--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancel_token_hash_unique" UNIQUE("cancel_token_hash");