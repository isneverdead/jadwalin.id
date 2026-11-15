-- Paket Gratis = masa uji 14 hari. Usaha baru otomatis dapat plan_until = sekarang + 14 hari.
-- NULL pada paket gratis tetap berarti "tanpa batas" (hanya bisa diatur superadmin).
ALTER TABLE "workspaces" ALTER COLUMN "plan_until" SET DEFAULT (now() + interval '14 days');--> statement-breakpoint
-- Usaha gratis yang sudah ada mendapat 14 hari sejak migrasi ini (bukan sejak dibuat).
UPDATE "workspaces" SET "plan_until" = now() + interval '14 days' WHERE "plan" = 'gratis' AND "plan_until" IS NULL AND "deleted_at" IS NULL;
