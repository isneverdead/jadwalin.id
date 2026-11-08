ALTER TABLE "meeting_types" ADD CONSTRAINT "meeting_types_step_valid" CHECK ("slot_step_min" BETWEEN 5 AND 240);
--> statement-breakpoint
-- Override: 'blocked' boleh seharian (tanpa jam) atau sebagian (dua jam terisi); 'extra' wajib punya jam.
ALTER TABLE "availability_overrides" ADD CONSTRAINT "availability_overrides_valid" CHECK (
  ("start_time" IS NULL) = ("end_time" IS NULL)
  AND ("start_time" IS NULL OR "end_time" > "start_time")
  AND ("kind" = 'blocked' OR "start_time" IS NOT NULL)
);
--> statement-breakpoint
-- Zona waktu workspace dibatasi ke tiga zona Indonesia (tanpa DST, offset tetap); aturan #7.
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_timezone_valid" CHECK ("timezone" IN ('Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'));
--> statement-breakpoint
CREATE INDEX "bookings_member_during" ON "bookings" USING gist ("member_id", "during");
--> statement-breakpoint
CREATE INDEX "availability_rules_member" ON "availability_rules" ("workspace_id", "member_id", "weekday");
--> statement-breakpoint
CREATE INDEX "availability_overrides_member_date" ON "availability_overrides" ("workspace_id", "member_id", "date");
