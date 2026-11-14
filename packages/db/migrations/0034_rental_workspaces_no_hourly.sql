-- Usaha yang sudah memakai katalog sewa tetapi belum punya layanan per jam: matikan "janji temu per jam" (menu Jadwal & layanan tidak relevan).
-- Pemilik bisa menyalakannya lagi di Pengaturan. Usaha yang punya layanan tidak disentuh.
UPDATE "workspaces" w SET "features" = w."features" || '{"jadwal": false}'::jsonb
WHERE (w."features"->>'sewa') = 'true'
  AND NOT EXISTS (SELECT 1 FROM "meeting_types" m WHERE m."workspace_id" = w."id");
