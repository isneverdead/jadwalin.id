"use client";

import { useEffect, useState } from "react";

type Mode = "light" | "dark";

function effective(): Mode {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Floating light/dark switch for the public landing page. Shares the "jd-theme" key with the dashboard.
export function LandingThemeToggle() {
  const [mode, setMode] = useState<Mode | null>(null);

  // Landing defaults to light unless the user explicitly chose a theme (incl. "auto" = follow the system) in the dashboard.
  useEffect(() => {
    const read = () => { try { return localStorage.getItem("jd-theme"); } catch { return null; } };
    const saved = read();
    const forced = saved !== "light" && saved !== "dark" && saved !== "auto";
    if (forced) document.documentElement.setAttribute("data-theme", "light");
    setMode(effective());
    return () => {
      if (!forced) return;
      const now = read();
      if (now !== "light" && now !== "dark") document.documentElement.removeAttribute("data-theme");
    };
  }, []);

  const toggle = () => {
    const next: Mode = effective() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("jd-theme", next); } catch { /* ignore */ }
    setMode(next);
  };

  const dark = mode === "dark";
  return (
    <button type="button" className="lp-theme" onClick={toggle} aria-label={dark ? "Ganti ke mode terang" : "Ganti ke mode gelap"} title={dark ? "Mode terang" : "Mode gelap"} suppressHydrationWarning>
      {dark ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
      )}
    </button>
  );
}
