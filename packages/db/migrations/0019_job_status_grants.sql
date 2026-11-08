-- job_status: bukan tabel tenant dan tanpa data pribadi. Worker menulis; aplikasi web hanya membaca (endpoint kesiapan).
GRANT SELECT ON "job_status" TO jadwalin_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "job_status" TO jadwalin_worker;
