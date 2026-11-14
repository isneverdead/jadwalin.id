"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "idle" | "loading" | "done";

/**
 * Garis kemajuan tipis di atas layar: muncul seketika saat tautan diklik / formulir dikirim,
 * selesai ketika halaman (path atau query) berganti. Cadangan 12 detik agar tidak menggantung
 * (mis. aksi formulir yang tetap di halaman yang sama).
 */
export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [phase, setPhase] = useState<Phase>("idle");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  const finish = useCallback(() => {
    clear();
    setPhase((p) => (p === "loading" ? "done" : p));
    timers.current.push(setTimeout(() => setPhase("idle"), 400));
  }, []);
  const start = useCallback(() => {
    clear();
    setPhase("loading");
    timers.current.push(setTimeout(finish, 12_000));
  }, [finish]);

  // Halaman berganti → selesai.
  useEffect(() => {
    finish();
  }, [pathname, search, finish]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !a.href || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return; // sama / hanya #hash
      start();
    };
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement | null;
      if (!form || e.defaultPrevented) return;
      if (form.target === "_blank") return;
      start();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("submit", onSubmit);
      clear();
    };
  }, [start]);

  return <div className="nav-progress" data-phase={phase} role="progressbar" aria-hidden={phase === "idle"} aria-label="Memuat halaman" />;
}
