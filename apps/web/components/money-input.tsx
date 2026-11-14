"use client";
import { useState } from "react";

/** Isian Rupiah dengan pemisah ribuan titik (450.000). Menyimpan angka murni; tanpa float, hanya digit. */
export function MoneyInput({ value, onChange, placeholder, id, required }: { value: number; onChange: (n: number) => void; placeholder?: string; id?: string; required?: boolean }) {
  return (
    <span className="money">
      <span className="money-rp" aria-hidden="true">Rp</span>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        required={required}
        placeholder={placeholder}
        value={value ? value.toLocaleString("id-ID") : ""}
        onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, "").slice(0, 12)) || 0)}
      />
    </span>
  );
}

/** Versi untuk <form> server action: tampil ber-titik, kirim angka murni lewat input tersembunyi `name`. */
export function MoneyField({ name, defaultValue = 0, placeholder, required }: { name: string; defaultValue?: number; placeholder?: string; required?: boolean }) {
  const [v, setV] = useState(defaultValue);
  return (
    <>
      <input type="hidden" name={name} value={v || ""} />
      <MoneyInput value={v} onChange={setV} placeholder={placeholder} required={required} />
    </>
  );
}
