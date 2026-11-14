"use client";
import { useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

/**
 * Tombol submit yang meminta konfirmasi dulu; dipakai untuk tindakan yang tidak bisa dibatalkan.
 * Memakai dialog di dalam halaman (bukan window.confirm) supaya jalan di semua browser,
 * termasuk browser dalam aplikasi yang memblokir dialog bawaan, dan bisa ditata sesuai desain.
 */
export function ConfirmButton({ message, children, className, ...rest }: { message: string; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children" | "type">) {
  const dlg = useRef<HTMLDialogElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        {...rest}
        ref={btn}
        type="button"
        className={className}
        onClick={() => dlg.current?.showModal()}
      >
        {children}
      </button>
      <dialog ref={dlg} className="help-dialog confirm-dialog" aria-label="Konfirmasi">
        <div className="help-card">
          <p className="confirm-msg">{message}</p>
          <div className="confirm-actions">
            <button type="button" className="btn-ghost" onClick={() => dlg.current?.close()}>Kembali</button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                dlg.current?.close();
                const form = btn.current?.form;
                if (!form) return;
                // Tombol type="button" tidak ikut terkirim; teruskan name/value-nya (mis. decision=reject) lewat input tersembunyi.
                let hidden: HTMLInputElement | null = null;
                if (rest.name) {
                  hidden = document.createElement("input");
                  hidden.type = "hidden";
                  hidden.name = rest.name;
                  hidden.value = String(rest.value ?? "");
                  form.appendChild(hidden);
                }
                form.requestSubmit();
                hidden?.remove();
              }}
            >
              Ya, lanjutkan
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
