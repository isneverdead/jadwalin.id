import { describe, expect, it } from "vitest";
import { bookingCode, buildIcs, googleCalendarUrl } from "../src";

describe("kode booking", () => {
  it("stabil, berformat JDW-XXXXXX, tanpa karakter membingungkan, dan berbeda antar id", () => {
    const a = bookingCode("11111111-1111-1111-1111-111111111111");
    expect(a).toBe(bookingCode("11111111-1111-1111-1111-111111111111"));
    expect(a).toMatch(/^JDW-[2-9A-HJKMNP-Z]{6}$/);
    const codes = new Set(Array.from({ length: 500 }, (_, i) => bookingCode(`00000000-0000-0000-0000-${String(i).padStart(12, "0")}`)));
    expect(codes.size).toBeGreaterThan(495);
  });
});

describe("ics", () => {
  const base = { uid: "abc", title: "Sesi; Pilates, pagi", startsAt: new Date("2026-12-01T02:00:00Z"), endsAt: new Date("2026-12-01T03:00:00Z"), now: new Date("2026-11-12T00:00:00Z") };
  it("memuat waktu UTC, escape, CRLF, dan lipat baris panjang", () => {
    const ics = buildIcs({ ...base, description: "Kode: JDW-ABC234\nBawa matras " + "x".repeat(120), location: "Jl. Mawar 1, Jakarta" });
    expect(ics).toContain("DTSTART:20261201T020000Z");
    expect(ics).toContain("DTEND:20261201T030000Z");
    expect(ics).toContain("SUMMARY:Sesi\; Pilates\\, pagi");
    expect(ics).toContain("LOCATION:Jl. Mawar 1\\, Jakarta");
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(ics.replace(/\r\n /g, "")).toContain("Bawa matras " + "x".repeat(120));
  });
  it("tautan Google Kalender membawa judul dan rentang waktu", () => {
    const u = new URL(googleCalendarUrl(base));
    expect(u.searchParams.get("dates")).toBe("20261201T020000Z/20261201T030000Z");
    expect(u.searchParams.get("text")).toBe("Sesi; Pilates, pagi");
  });
});
