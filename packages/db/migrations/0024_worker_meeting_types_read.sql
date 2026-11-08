-- Konfirmasi booking oleh pembayaran (webhook, tanpa konteks pengguna) perlu judul jenis pertemuan. Hanya kolom yang perlu.
GRANT SELECT (id, workspace_id, title, deposit_idr) ON "meeting_types" TO jadwalin_worker;
--> statement-breakpoint
CREATE POLICY worker_meeting_types_select ON "meeting_types" FOR SELECT TO jadwalin_worker USING (true);
