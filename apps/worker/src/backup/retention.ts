export interface BackupRef {
  key: string;
  createdAt: Date;
}

/**
 * Kebijakan retensi: simpan yang TERBARU per hari untuk 7 hari terakhir, per minggu (ISO) untuk 4 minggu, dan per bulan
 * untuk 6 bulan. Backup paling baru selalu disimpan. Mengembalikan kunci yang boleh dihapus. Murni (tanpa I/O).
 */
export function selectForDeletion(all: BackupRef[], now: Date, policy = { daily: 7, weekly: 4, monthly: 6 }): string[] {
  const sorted = [...all].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const keep = new Set<string>();
  if (sorted[0]) keep.add(sorted[0].key);

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const monthKey = (d: Date) => d.toISOString().slice(0, 7);
  const weekKey = (d: Date) => {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dow);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)}`;
  };

  const pick = (keyOf: (d: Date) => string, limit: number) => {
    const seen = new Set<string>();
    for (const b of sorted) {
      const k = keyOf(b.createdAt);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(b.key);
    }
  };
  pick(dayKey, policy.daily);
  pick(weekKey, policy.weekly);
  pick(monthKey, policy.monthly);
  void now;
  return sorted.filter((b) => !keep.has(b.key)).map((b) => b.key);
}
