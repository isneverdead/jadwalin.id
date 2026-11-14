-- ADR 0004: pemulihan tautan booking memutar token kelola lewat role worker (kolom cancel_token_hash saja).
-- Policy lama (0023) hanya mengizinkan baris 'pending'; booking terkonfirmasi juga perlu bisa dipulihkan. WITH CHECK menjaga
-- agar jalur ini tidak bisa membatalkan/menyelesaikan booking (status tetap pending/confirmed).
CREATE POLICY worker_bookings_rotate_token ON "bookings" FOR UPDATE TO jadwalin_worker
  USING (status IN ('pending', 'confirmed')) WITH CHECK (status IN ('pending', 'confirmed'));
