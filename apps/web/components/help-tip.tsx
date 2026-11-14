"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export type HelpDemoKey = "pilih" | "fitur" | "layanan" | "produk" | "jam" | "nama";

const Cursor = ({ cls }: { cls: string }) => (
  <svg className={`hd-cursor ${cls}`} viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 3l14 8-6 2 4 7-3 1.5-4-7-5 4z" fill="#fff" stroke="#0b1722" strokeWidth="1.4" strokeLinejoin="round" /></svg>
);

/** Peragaan animasi (CSS murni, berulang). Tanpa JS dan otomatis diam bila pengguna meminta gerakan dikurangi. */
function Demo({ kind }: { kind: HelpDemoKey }): ReactNode {
  switch (kind) {
    case "pilih":
      return (
        <div className="hd">
          <div className="hd-grid">
            <div className="hd-card"><b>Dokter</b><i /><i /></div>
            <div className="hd-card hd-pick"><b>Salon</b><i /><i /></div>
            <div className="hd-card"><b>Guru les</b><i /><i /></div>
          </div>
          <div className="hd-chip hd-chip-pilih">✓ Layanan &amp; jam kerja siap</div>
          <Cursor cls="hd-cur-pilih" />
        </div>
      );
    case "fitur":
      return (
        <div className="hd">
          <div className="hd-feat"><span className="hd-sw hd-sw-on"><u /></span><span><b>Tiket &amp; pesan klien</b><i /></span></div>
          <div className="hd-feat"><span className="hd-sw hd-sw-flip"><u /></span><span><b>DP &amp; pembayaran</b><i /></span></div>
          <div className="hd-feat"><span className="hd-sw hd-sw-on"><u /></span><span><b>Penyimpanan berkas</b><i /></span></div>
          <div className="hd-chip hd-chip-fitur">Menu “Pembayaran” disembunyikan</div>
          <Cursor cls="hd-cur-fitur" />
        </div>
      );
    case "layanan":
      return (
        <div className="hd">
          <div className="hd-row">
            <span className="hd-field hd-w1"><small>Nama layanan</small><em className="hd-type hd-type-a">Konsultasi awal</em></span>
            <span className="hd-field hd-w2"><small>Durasi</small><em>30</em></span>
            <span className="hd-field hd-w2"><small>DP (Rp)</small><em className="hd-type hd-type-b">50000</em></span>
          </div>
          <div className="hd-row hd-row-new">
            <span className="hd-field hd-w1"><small>Nama layanan</small><em>Sesi lanjutan</em></span>
            <span className="hd-field hd-w2"><small>Durasi</small><em>60</em></span>
            <span className="hd-field hd-w2"><small>DP (Rp)</small><em>100000</em></span>
          </div>
          <div className="hd-add">+ Tambah layanan</div>
          <Cursor cls="hd-cur-layanan" />
        </div>
      );
    case "produk":
      return (
        <div className="hd">
          <div className="hd-row">
            <span className="hd-field hd-w1"><small>Nama produk</small><em className="hd-type hd-type-a">Toyota Avanza</em></span>
            <span className="hd-field hd-w2"><small>Harga / hari</small><em className="hd-type hd-type-b">Rp450.000</em></span>
            <span className="hd-field hd-w2"><small>Unit</small><em>2</em></span>
          </div>
          <div className="hd-row hd-row-new">
            <span className="hd-field hd-w1"><small>Nama produk</small><em>Daihatsu Xenia</em></span>
            <span className="hd-field hd-w2"><small>Harga / hari</small><em>Rp400.000</em></span>
            <span className="hd-field hd-w2"><small>Unit</small><em>2</em></span>
          </div>
          <div className="hd-add">+ Tambah produk</div>
          <Cursor cls="hd-cur-layanan" />
        </div>
      );
    case "jam":
      return (
        <div className="hd">
          <div className="hd-day"><span className="hd-sw hd-sw-on"><u /></span><b>Jumat</b><em>09.00 – 17.00</em></div>
          <div className="hd-day"><span className="hd-sw hd-sw-flip"><u /></span><b>Sabtu</b><em className="hd-fadein">10.00 – 14.00</em><em className="hd-fadeout">Libur</em></div>
          <div className="hd-day hd-day-extra"><span className="hd-sw hd-sw-on"><u /></span><b>Senin</b><em>08.00 – 12.00</em><em className="hd-plus">+ jam</em><em className="hd-second">16.00 – 20.00</em></div>
          <Cursor cls="hd-cur-jam" />
        </div>
      );
    case "nama":
      return (
        <div className="hd">
          <span className="hd-field hd-wide"><small>Nama Anda atau nama praktik</small><em className="hd-type hd-type-name">Rina Wulandari</em></span>
          <span className="hd-field hd-wide"><small>Alamat link</small><em className="hd-mono">jadwalin.id/<span className="hd-type hd-type-slug">rina-wulandari</span></em></span>
          <div className="hd-url"><span aria-hidden="true">🔒</span> jadwalin.id/<span className="hd-type hd-type-slug2">rina-wulandari</span></div>
          <div className="hd-chip hd-chip-nama">Buat halaman jadwal saya</div>
        </div>
      );
  }
}

/** Tombol "?" di samping judul: membuka lapisan (overlay) animasi berisi cara pemakaian bagian itu. */
export function HelpTip({ title, demo, steps }: { title: string; demo: HelpDemoKey; steps: string[] }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const close = () => ref.current?.close();
  // Denyut perhatian hanya untuk pengguna yang belum pernah membuka panduan ini (disimpan di peramban; opsional).
  const key = `help-seen:${demo}`;
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    try { setSeen(localStorage.getItem(key) === "1"); } catch { setSeen(true); }
  }, [key]);
  function open() {
    ref.current?.showModal();
    setSeen(true);
    try { localStorage.setItem(key, "1"); } catch { /* penyimpanan tak tersedia */ }
  }
  return (
    <>
      <button type="button" className={`help-btn${seen ? "" : " pulse"}`} aria-label={`Cara memakai: ${title}`} title="Klik untuk melihat cara memakai bagian ini" onClick={open}>
        <span className="help-q" aria-hidden="true">?</span>
        <span className="help-label">Cara pakai</span>
      </button>
      <dialog
        ref={ref}
        className="help-dialog"
        aria-labelledby={id}
        onClick={(e) => { if (e.target === ref.current) close(); }}
      >
        <div className="help-card">
          <header className="help-head">
            <h3 id={id}>{title}</h3>
            <button type="button" className="help-x" onClick={close} aria-label="Tutup panduan">×</button>
          </header>
          <Demo kind={demo} />
          <ol className="help-steps">
            {steps.map((s, i) => <li key={i} style={{ animationDelay: `${0.15 + i * 0.12}s` }}>{s}</li>)}
          </ol>
          <button type="button" className="help-ok" onClick={close}>Mengerti</button>
        </div>
      </dialog>
    </>
  );
}
