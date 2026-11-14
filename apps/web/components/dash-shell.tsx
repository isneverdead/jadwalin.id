"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

type Theme = "auto" | "light" | "dark";
const THEMES: { id: Theme; label: string }[] = [
  { id: "auto", label: "Otomatis" },
  { id: "light", label: "Terang" },
  { id: "dark", label: "Gelap" },
];

function applyTheme(t: Theme) {
  const r = document.documentElement;
  if (t === "auto") r.removeAttribute("data-theme");
  else r.setAttribute("data-theme", t);
}

/**
 * Kerangka dasbor: >= 1024px sidebar tetap; di bawahnya bilah atas + laci menu
 * (ESC menutup, fokus kembali ke tombol Menu, laci tertutup tidak bisa difokus).
 */
export function DashShell({ bizName, aside, children }: { bizName: string; aside: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("auto");
  const menuBtn = useRef<HTMLButtonElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const path = usePathname();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) menuBtn.current?.focus();
  }, []);

  useEffect(() => {
    try {
      const t = localStorage.getItem("jd-theme");
      if (t === "light" || t === "dark") { setTheme(t); applyTheme(t); }
    } catch { /* penyimpanan bisa diblokir */ }
  }, []);

  useEffect(() => { setOpen(false); }, [path]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    if (open) closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && open) close(true); };
    document.addEventListener("keydown", onKey);
    const mq = window.matchMedia("(min-width: 1024px)");
    const onMq = () => { if (mq.matches) setOpen(false); };
    mq.addEventListener("change", onMq);
    return () => { document.removeEventListener("keydown", onKey); mq.removeEventListener("change", onMq); document.body.style.overflow = ""; };
  }, [open, close]);

  const pick = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    try { localStorage.setItem("jd-theme", t); } catch { /* abaikan */ }
  };

  return (
    <div className="shell">
      <div className="mbar">
        <div className="biz"><span className="avatar sm" aria-hidden="true">{bizName.slice(0, 1).toUpperCase()}</span><span>{bizName}</span></div>
        <button ref={menuBtn} type="button" className="btn-ghost menu-btn" aria-expanded={open} aria-controls="dash-side" onClick={() => setOpen(true)}>Menu</button>
      </div>
      <div className={`scrim${open ? " open" : ""}`} onClick={() => close(true)} aria-hidden="true" />
      <aside id="dash-side" className={`side${open ? " open" : ""}`} aria-label="Navigasi usaha">
        <button ref={closeBtn} type="button" className="side-close btn-ghost" aria-label="Tutup menu" onClick={() => close(true)}>✕</button>
        {aside}
        <div className="themes" role="group" aria-label="Tema">
          {THEMES.map((t) => (
            <button key={t.id} type="button" aria-pressed={theme === t.id} onClick={() => pick(t.id)}>{t.label}</button>
          ))}
        </div>
      </aside>
      <div className="shell-main">{children}</div>
    </div>
  );
}
