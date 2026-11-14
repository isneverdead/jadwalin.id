"use client";

import { useEffect, useRef, useState } from "react";

// Looping storyboard of the real flow: the guest books and uploads a DP proof, the owner verifies it.
// Purely illustrative (aria-hidden visuals + a text summary for screen readers). No libraries.
const CAPTIONS = [
  "Klien membuka halaman booking dan memilih jam",
  "Slot dipilih, klien menekan Booking",
  "Klien transfer DP lalu unggah bukti",
  "Pemilik menerima bukti bayar di dashboard",
  "Pemilik verifikasi, slot langsung terkunci",
  "Klien menerima konfirmasi booking",
] as const;

const LAST = CAPTIONS.length - 1;
const TICK_MS = 2300;
const SLOTS = ["08.00", "09.00", "10.00", "11.00", "13.00", "14.00"] as const;

export function LandingDemo() {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(true);
  const [still, setStill] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => { setStill(mq.matches); if (mq.matches) setStep(LAST); };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setVisible(entries[0]?.isIntersecting ?? true), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (still || !visible) return;
    const t = setTimeout(() => setStep((s) => (s >= LAST ? 0 : s + 1)), TICK_MS);
    return () => clearTimeout(t);
  }, [step, still, visible]);

  const ownerSide = step === 3 || step === 4;
  const slot = step >= 1;
  const view = step <= 1 ? "pick" : step === 2 ? "pay" : "done";
  const row = step <= 2 ? "empty" : step === 3 ? "pending" : "locked";

  return (
    <div className="lpd" ref={root} data-step={step}>
      <p className="sr-only">
        Contoh alur: klien memilih jam di halaman booking, transfer DP dan mengunggah bukti. Pemilik usaha menerima bukti di dashboard, memverifikasinya, dan slot terkunci. Klien lalu menerima konfirmasi.
      </p>
      <div className="lpd-stage" aria-hidden="true">
        <div className={`lpd-side lpd-guest${ownerSide ? "" : " is-active"}`}>
          <span className="lpd-tag">Sisi klien</span>
          <div className="lpd-phone">
            <div className="lpd-url"><i /> jadwalin.id/nama-usaha</div>
            <div className={`lpd-view${view === "pick" ? " on" : ""}`}>
              <b>Pilih jam</b>
              <div className="lpd-slots">
                {SLOTS.map((s) => (
                  <span key={s} className={s === "08.00" || s === "14.00" ? "off" : s === "10.00" && slot ? "sel" : ""}>{s}</span>
                ))}
              </div>
              <div className={`lpd-btn${step === 1 ? " press" : ""}`}>Booking</div>
            </div>
            <div className={`lpd-view${view === "pay" ? " on" : ""}`}>
              <b>Bayar DP</b>
              <p>Transfer ke rekening penyedia, lalu unggah bukti.</p>
              <div className="lpd-file"><span>bukti-transfer.jpg</span><em><u /></em></div>
              <div className="lpd-badge warn">Menunggu verifikasi</div>
            </div>
            <div className={`lpd-view${view === "done" ? " on" : ""}`}>
              <div className="lpd-check"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></div>
              <b>{step === 5 ? "Booking terkonfirmasi" : "Menunggu verifikasi"}</b>
              <p>{step === 5 ? "Sampai jumpa di jam 10.00." : "Pemilik sedang memeriksa bukti bayar."}</p>
              <div className={`lpd-badge ${step === 5 ? "ok" : "warn"}`}>{step === 5 ? "Slot terkunci" : "Bukti terkirim"}</div>
            </div>
          </div>
        </div>

        <div className={`lpd-side lpd-owner${ownerSide ? " is-active" : ""}`}>
          <span className="lpd-tag">Sisi pemilik</span>
          <div className="lpd-dash">
            <div className="lpd-dash-top"><b>Dashboard</b><span className={`lpd-bell${step >= 3 && step < 5 ? " ring" : ""}`} /></div>
            <div className="lpd-tl">
              <div className="lpd-row ok"><time>09.00</time><span>Budi · Lapangan A</span></div>
              <div className={`lpd-row ${row}`}>
                <time>10.00</time>
                <span>{row === "empty" ? "Kosong" : row === "pending" ? "Rani · menunggu" : "Rani · terkunci"}</span>
              </div>
              <div className="lpd-row empty"><time>11.00</time><span>Kosong</span></div>
            </div>
            <div className={`lpd-queue${step >= 3 && step < 5 ? " on" : ""}`}>
              <div><small>Bukti bayar baru</small><b>Rani · DP booking</b></div>
              <span className={`lpd-verify${step === 4 ? " done" : ""}`}>{step === 4 ? "Terverifikasi" : "Verifikasi"}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="lpd-foot">
        <p className="lpd-cap" aria-live="off">{CAPTIONS[step]}</p>
        <div className="lpd-dots" role="group" aria-label="Langkah demo">
          {CAPTIONS.map((c, i) => (
            <button key={c} type="button" className={i === step ? "on" : ""} onClick={() => setStep(i)} aria-label={`Langkah ${i + 1}: ${c}`} aria-current={i === step} />
          ))}
        </div>
      </div>
    </div>
  );
}
