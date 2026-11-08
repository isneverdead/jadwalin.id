/** Uang selalu integer Rupiah (aturan #5). */
export type Rupiah = number & { readonly __brand: "Rupiah" };

export function rupiah(value: number): Rupiah {
  if (!Number.isSafeInteger(value)) throw new Error(`Rupiah harus integer: ${value}`);
  return value as Rupiah;
}

export function formatRupiah(value: Rupiah): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}Rp${Math.abs(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

/** Fee platform dalam persen, dibulatkan ke bawah agar tidak pernah melebihi persentase yang dijanjikan. */
export function platformFee(amount: Rupiah, percent: number): Rupiah {
  return rupiah(Math.floor((amount * percent) / 100));
}
