CREATE TABLE "ticket_counters" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD COLUMN "client_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD COLUMN "author_kind" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD COLUMN "client_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_clients" ADD COLUMN "blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_counters" ADD CONSTRAINT "ticket_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;