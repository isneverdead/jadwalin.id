export class InvalidPhoneError extends Error {
  constructor(input: string) {
    super(`Nomor HP tidak valid: ${input}`);
    this.name = "InvalidPhoneError";
  }
}

/**
 * Satu-satunya fungsi normalisasi nomor HP (aturan #6).
 * Menerima 08xx, 628xx, +628xx (spasi/tanda hubung diabaikan); hasil selalu 62xxx.
 */
export function normalizePhone(input: string): string {
  let digits = input.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) throw new InvalidPhoneError(input);

  if (digits.startsWith("0")) digits = "62" + digits.slice(1);
  else if (!digits.startsWith("62")) throw new InvalidPhoneError(input);

  // Seluler Indonesia: 62 8xx + 8–11 digit lagi.
  if (!/^628\d{8,11}$/.test(digits)) throw new InvalidPhoneError(input);
  return digits;
}
