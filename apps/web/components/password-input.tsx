"use client";
import { useState, type InputHTMLAttributes } from "react";

/** Isian kata sandi dengan tombol mata untuk menampilkan/menyembunyikan (target sentuh 44px, bisa dipakai keyboard). */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [shown, setShown] = useState(false);
  return (
    <span className="pw-field">
      <input {...props} type={shown ? "text" : "password"} />
      <button type="button" className="pw-eye" aria-label={shown ? "Sembunyikan kata sandi" : "Tampilkan kata sandi"} aria-pressed={shown} onClick={() => setShown((v) => !v)}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {shown ? (
            <path d="M3 3l18 18M10.6 6.2A9.8 9.8 0 0 1 12 6c5 0 8.5 4 9.5 6a14.6 14.6 0 0 1-2.9 3.8M6.3 6.8A14.8 14.8 0 0 0 2.5 12c1 2 4.5 6 9.5 6 1.6 0 3-.4 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2" />
          ) : (
            <>
              <path d="M2.5 12C3.5 10 7 6 12 6s8.5 4 9.5 6c-1 2-4.5 6-9.5 6S3.5 14 2.5 12z" />
              <circle cx="12" cy="12" r="3" />
            </>
          )}
        </svg>
      </button>
    </span>
  );
}
