/** Kerangka halaman yang tampil selama data halaman berikutnya dimuat. */
export function PageSkeleton() {
  return (
    <div className="skel-page" role="status" aria-live="polite" aria-label="Memuat halaman">
      <span className="skel skel-title" />
      <span className="skel skel-line" />
      <div className="skel-grid">
        <span className="skel skel-card" />
        <span className="skel skel-card" />
        <span className="skel skel-card" />
      </div>
      <span className="skel skel-block" />
    </div>
  );
}
