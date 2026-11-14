-- ADR 0004: nomor WhatsApp usaha untuk tombol "Hubungi langsung" (wa.me) di halaman booking pelanggan.
ALTER TABLE "workspaces" ADD COLUMN "contact_phone" text;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_contact_phone" CHECK ("contact_phone" IS NULL OR "contact_phone" ~ '^62[0-9]{8,13}$');
