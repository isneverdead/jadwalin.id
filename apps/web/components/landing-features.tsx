"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

type Feature = readonly [title: string, text: string, size: string];


// One small animated SVG per feature (CSS keyframes in globals.css, `.lpi*`). Decorative only.
const ICONS: ReactNode[] = [
  // Booking page: browser window, address bar typing, button pulsing
  <svg key="page" viewBox="0 0 48 48" className="lpi lpi-page" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="8" width="38" height="32" rx="6" /><path d="M5 17h38" /><rect className="lpi-type" x="10" y="11" width="18" height="3" rx="1.5" fill="currentColor" stroke="none" /><rect x="11" y="23" width="14" height="3" rx="1.5" fill="currentColor" stroke="none" opacity=".35" /><rect x="11" y="29" width="22" height="3" rx="1.5" fill="currentColor" stroke="none" opacity=".35" /><rect className="lpi-pulse" x="28" y="31" width="10" height="6" rx="3" fill="var(--accent)" stroke="none" /></svg>,
  // No double-booking: second block is rejected, first stays locked
  <svg key="clash" viewBox="0 0 48 48" className="lpi lpi-clash" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="7" width="36" height="10" rx="4" opacity=".4" /><rect className="lpi-slot" x="6" y="19" width="36" height="10" rx="4" fill="var(--accent)" stroke="none" /><rect x="6" y="31" width="36" height="10" rx="4" opacity=".4" /><rect className="lpi-bounce" x="12" y="19" width="24" height="10" rx="4" fill="var(--signal)" stroke="none" /><path className="lpi-x" d="M20 21.5l8 5M28 21.5l-8 5" stroke="#fff" /></svg>,
  // Manual DP: banknote with an upload arrow and a check
  <svg key="dp" viewBox="0 0 48 48" className="lpi lpi-dp" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="18" width="38" height="22" rx="5" /><circle cx="24" cy="29" r="5" /><g className="lpi-up"><path d="M24 14V4M19 9l5-5 5 5" stroke="var(--accent)" /></g><circle className="lpi-ok" cx="38" cy="14" r="7" fill="var(--ok)" stroke="none" /><path className="lpi-ok" d="M34.5 14l2.5 2.5 4-5" stroke="#fff" /></svg>,
  // Owner dashboard: bars growing + ping
  <svg key="dash" viewBox="0 0 48 48" className="lpi lpi-dash" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="6" width="38" height="36" rx="6" /><g fill="var(--accent)" stroke="none"><rect className="lpi-bar b1" x="12" y="20" width="6" height="16" rx="2" /><rect className="lpi-bar b2" x="21" y="20" width="6" height="16" rx="2" /><rect className="lpi-bar b3" x="30" y="20" width="6" height="16" rx="2" /></g><circle className="lpi-ping" cx="36" cy="13" r="3" fill="var(--signal)" stroke="none" /></svg>,
  // Rentals: key swinging on a tag
  <svg key="rent" viewBox="0 0 48 48" className="lpi lpi-rent" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="24" cy="6" r="2" fill="currentColor" /><g className="lpi-swing"><path d="M24 8v8" /><circle cx="24" cy="23" r="7" /><circle cx="24" cy="23" r="2" fill="var(--accent)" stroke="none" /><path d="M24 30v12M24 36h5M24 41h4" stroke="var(--accent)" /></g></svg>,
];

const AUTO_MS = 4200;
const PAUSE_MS = 9000;

// Desktop: plain bento grid. Mobile (CSS): a card stack that auto-rotates and can be swiped, tapped or stepped manually.
export function LandingFeatures({ items }: { items: readonly Feature[] }) {
  const n = items.length;
  const [active, setActive] = useState(0);
  const [visible, setVisible] = useState(true);
  const [still, setStill] = useState(false);
  const [pausedUntil, setPausedUntil] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStill(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setVisible(entries[0]?.isIntersecting ?? true), { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (still || !visible) return;
    const wait = Math.max(AUTO_MS, pausedUntil - Date.now() + 200);
    const t = setTimeout(() => setActive((a) => (a + 1) % n), wait);
    return () => clearTimeout(t);
  }, [active, still, visible, pausedUntil, n]);

  const go = (i: number) => {
    setActive(((i % n) + n) % n);
    setPausedUntil(Date.now() + PAUSE_MS);
  };

  return (
    <div className="lp-feat" ref={root}>
      <div
        className="lp-bento"
        onTouchStart={(e) => { const t = e.touches[0]; if (t) touch.current = { x: t.clientX, y: t.clientY }; }}
        onTouchEnd={(e) => {
          const s = touch.current; const t = e.changedTouches[0];
          touch.current = null;
          if (!s || !t) return;
          const dx = t.clientX - s.x;
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(t.clientY - s.y)) go(active + (dx < 0 ? 1 : -1));
        }}
      >
        {items.map(([t, d, w], i) => {
          const o = (i - active + n) % n;
          return (
            <div className={`lp-tile ${w}`} key={t} style={{ "--o": o } as CSSProperties} onClick={() => o === 0 && go(active + 1)}>
              <div className="lp-tile-head"><span className="lp-ico" aria-hidden="true">{ICONS[i]}</span><h3>{t}</h3></div>
              <p>{d}</p>
            </div>
          );
        })}
      </div>
      <div className="lp-stack-ctl">
        <button type="button" onClick={() => go(active - 1)} aria-label="Kartu sebelumnya">‹</button>
        <div className="lp-stack-dots" role="group" aria-label="Pilih kartu">
          {items.map(([t], i) => (
            <button key={t} type="button" className={i === active ? "on" : ""} onClick={() => go(i)} aria-label={`Kartu ${i + 1}: ${t}`} aria-current={i === active} />
          ))}
        </div>
        <button type="button" onClick={() => go(active + 1)} aria-label="Kartu berikutnya">›</button>
      </div>
    </div>
  );
}
