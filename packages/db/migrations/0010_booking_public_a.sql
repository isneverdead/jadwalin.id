ALTER TYPE "public"."outbox_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "meeting_type_hosts" (
	"workspace_id" uuid NOT NULL,
	"meeting_type_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	CONSTRAINT "meeting_type_hosts_meeting_type_id_member_id_unique" UNIQUE("meeting_type_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "rate_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancel_token_hash" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_type_hosts" ADD CONSTRAINT "meeting_type_hosts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_type_hosts" ADD CONSTRAINT "meeting_type_hosts_meeting_type_id_meeting_types_id_fk" FOREIGN KEY ("meeting_type_id") REFERENCES "public"."meeting_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_type_hosts" ADD CONSTRAINT "meeting_type_hosts_member_id_workspace_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."workspace_members"("id") ON DELETE cascade ON UPDATE no action;