CREATE TABLE "job_status" (
	"job" text PRIMARY KEY NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"last_error" text,
	"last_detail" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
