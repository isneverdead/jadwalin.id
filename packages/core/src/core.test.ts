import { describe, expect, it } from "vitest";
import { formatRupiah, InvalidPhoneError, normalizePhone, platformFee, rupiah } from "./index";

describe("normalizePhone", () => {
  it.each([
    ["0812-3456-7890", "6281234567890"],
    ["+62 812 3456 7890", "6281234567890"],
    ["6281234567890", "6281234567890"],
    ["(0812) 3456 7890", "6281234567890"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(["", "abc", "812345", "0211234567", "+1 415 555 0100", "08123"])("menolak %s", (input) => {
    expect(() => normalizePhone(input)).toThrow(InvalidPhoneError);
  });
});

describe("rupiah", () => {
  it("menolak pecahan dan NaN", () => {
    expect(() => rupiah(1.5)).toThrow();
    expect(() => rupiah(NaN)).toThrow();
  });
  it("format dengan titik ribuan", () => {
    expect(formatRupiah(rupiah(79000))).toBe("Rp79.000");
    expect(formatRupiah(rupiah(1250000))).toBe("Rp1.250.000");
  });
  it("fee 2% dibulatkan ke bawah", () => {
    expect(platformFee(rupiah(100000), 2)).toBe(2000);
    expect(platformFee(rupiah(12345), 2)).toBe(246);
  });
});
