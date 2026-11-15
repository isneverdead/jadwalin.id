-- Usaha milik akun yang ditangguhkan disembunyikan dari semua pintu publik (bukan soft delete, bisa dipulihkan).
ALTER TABLE "workspaces" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
GRANT UPDATE ("blocked_at") ON "workspaces" TO jadwalin_worker;--> statement-breakpoint
UPDATE "workspaces" SET "blocked_at" = now() WHERE "id" IN (SELECT wm."workspace_id" FROM "workspace_members" wm JOIN "users" u ON u."id" = wm."user_id" WHERE wm."role" = 'owner' AND u."suspended_at" IS NOT NULL);
