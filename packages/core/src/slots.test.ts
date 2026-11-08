import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDays,
  computeSlots,
  localDateOf,
  localToUtcMs,
  TIMEZONE_OFFSET_MIN,
  weekdayOf,
  windowsForDate,
  type BusyRange,
  type DateOverride,
  type SlotInput,
  type WeeklyRule,
  type WorkspaceTimezone,
} from "./slots";

const MIN = 60_000;
const DAY = 86_400_000;

// Senin 2030-01-07 08:00 WIB = 01:00Z
const NOW = new Date("2030-01-07T01:00:00Z");

const base: SlotInput = {
  now: NOW,
  timezone: "Asia/Jakarta",
  durationMin: 60,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeMin: 0,
  maxDaysAhead: 7,
  stepMin: 60,
  rules: [{ weekday: 1, start: "09:00", end: "12:00" }],
  overrides: [],
  busy: [],
};
const iso = (slots: { start: Date }[]) => slots.map((s) => s.start.toISOString());

describe("zona waktu Indonesia", () => {
  it.each<[WorkspaceTimezone, string]>([
    ["Asia/Jakarta", "2030-01-07T02:00:00.000Z"], // WIB UTC+7
    ["Asia/Makassar", "2030-01-07T01:00:00.000Z"], // WITA UTC+8
    ["Asia/Jayapura", "2030-01-07T00:00:00.000Z"], // WIT UTC+9
  ])("09:00 lokal di %s adalah %s", (tz, expected) => {
    expect(new Date(localToUtcMs("2030-01-07", 9 * 60, TIMEZONE_OFFSET_MIN[tz])).toISOString()).toBe(expected);
  });

  it("jam yang sama menghasilkan instan berbeda per zona", () => {
    const starts = (tz: WorkspaceTimezone) => iso(computeSlots({ ...base, timezone: tz, now: new Date("2030-01-06T00:00:00Z"), maxDaysAhead: 2 }))[0];
    expect(starts("Asia/Jakarta")).toBe("2030-01-07T02:00:00.000Z");
    expect(starts("Asia/Makassar")).toBe("2030-01-07T01:00:00.000Z");
    expect(starts("Asia/Jayapura")).toBe("2030-01-07T00:00:00.000Z");
  });

  it("tanggal dan hari lokal mengikuti zona, bukan UTC (23:30 UTC Minggu = Senin 06:30 WIB)", () => {
    const instant = Date.parse("2030-01-06T23:30:00Z");
    expect(localDateOf(instant, TIMEZONE_OFFSET_MIN["Asia/Jakarta"])).toBe("2030-01-07");
    expect(weekdayOf("2030-01-07")).toBe(1);
    expect(localDateOf(instant, 0)).toBe("2030-01-06");
  });

  it("jam rutin Senin dihitung pada hari Senin lokal walau instan UTC-nya masih Minggu", () => {
    // Senin 06:00 WIB = Minggu 23:00Z. Jendela 06:00–08:00 harus muncul sebagai Senin.
    const slots = computeSlots({
      ...base,
      now: new Date("2030-01-06T12:00:00Z"),
      rules: [{ weekday: 1, start: "06:00", end: "08:00" }],
      maxDaysAhead: 2,
    });
    expect(iso(slots)).toEqual(["2030-01-06T23:00:00.000Z", "2030-01-07T00:00:00.000Z"]);
  });
});

describe("computeSlots (contoh)", () => {
  it("jam rutin menghasilkan slot sesuai langkah", () => {
    expect(iso(computeSlots({ ...base, now: new Date("2030-01-06T00:00:00Z"), maxDaysAhead: 2 }))).toEqual([
      "2030-01-07T02:00:00.000Z",
      "2030-01-07T03:00:00.000Z",
      "2030-01-07T04:00:00.000Z",
    ]);
  });

  it("pemberitahuan minimum menghilangkan slot yang terlalu dekat", () => {
    const slots = computeSlots({ ...base, minNoticeMin: 150 }); // sekarang 08:00 WIB → paling cepat 10:30
    expect(iso(slots).slice(0, 1)).toEqual(["2030-01-07T04:00:00.000Z"]); // 11:00 WIB
  });

  it("batas hari ke depan memotong slot", () => {
    const rules: WeeklyRule[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "10:00" }));
    const slots = computeSlots({ ...base, rules, now: new Date("2030-01-06T20:00:00Z"), maxDaysAhead: 2 });
    // sekarang Senin 03:00 WIB; slot 09:00 Sen, Sel; Rabu 09:00 = 2 hari + 6 jam → lewat
    expect(slots).toHaveLength(2);
  });

  it("libur seharian dan blokir sebagian", () => {
    const rules: WeeklyRule[] = [{ weekday: 1, start: "09:00", end: "12:00" }];
    const now = new Date("2030-01-06T00:00:00Z");
    const allDay: DateOverride[] = [{ date: "2030-01-07", kind: "blocked" }];
    expect(computeSlots({ ...base, now, rules, overrides: allDay, maxDaysAhead: 2 })).toHaveLength(0);
    const part: DateOverride[] = [{ date: "2030-01-07", kind: "blocked", start: "10:00", end: "11:00" }];
    expect(iso(computeSlots({ ...base, now, rules, overrides: part, maxDaysAhead: 2 }))).toEqual([
      "2030-01-07T02:00:00.000Z",
      "2030-01-07T04:00:00.000Z",
    ]);
  });

  it("jam tambahan membuka hari yang biasanya libur; blokir mengalahkan tambahan", () => {
    const now = new Date("2030-01-06T00:00:00Z");
    const extra: DateOverride[] = [{ date: "2030-01-08", kind: "extra", start: "13:00", end: "14:00" }];
    expect(iso(computeSlots({ ...base, now, overrides: extra, maxDaysAhead: 3 }))).toContain("2030-01-08T06:00:00.000Z");
    const both: DateOverride[] = [...extra, { date: "2030-01-08", kind: "blocked" }];
    expect(iso(computeSlots({ ...base, now, overrides: both, maxDaysAhead: 3 }))).not.toContain("2030-01-08T06:00:00.000Z");
  });

  it("buffer: booking 10:00–11:00 dengan buffer 30 menit menutup slot yang menyentuh area buffer", () => {
    const busy: BusyRange[] = [{ start: new Date("2030-01-07T03:00:00Z"), end: new Date("2030-01-07T04:00:00Z") }]; // 10:00–11:00 WIB
    const now = new Date("2030-01-06T00:00:00Z");
    const noBuffer = computeSlots({ ...base, now, busy, maxDaysAhead: 2, stepMin: 30 });
    expect(iso(noBuffer)).toContain("2030-01-07T02:00:00.000Z"); // 09:00–10:00 bersebelahan: boleh
    expect(iso(noBuffer)).toContain("2030-01-07T04:00:00.000Z"); // 11:00–12:00 bersebelahan: boleh
    const withBuffer = computeSlots({ ...base, now, busy, maxDaysAhead: 2, stepMin: 30, bufferBeforeMin: 30, bufferAfterMin: 30 });
    expect(iso(withBuffer)).not.toContain("2030-01-07T02:00:00.000Z"); // buffer sesudah 09:00–10:00 sampai 10:30
    expect(iso(withBuffer)).not.toContain("2030-01-07T04:00:00.000Z"); // buffer sebelum 11:00 mulai 10:30
  });

  it("windowsForDate menggabungkan jam yang tumpang tindih", () => {
    const rules: WeeklyRule[] = [
      { weekday: 1, start: "09:00", end: "11:00" },
      { weekday: 1, start: "10:00:00", end: "12:00:00" },
    ];
    expect(windowsForDate("2030-01-07", rules, [])).toEqual([[540, 720]]);
  });

  it("menolak jam tidak valid", () => {
    expect(() => windowsForDate("2030-01-07", [{ weekday: 1, start: "9am", end: "10:00" }], [])).toThrow();
  });
});

describe("computeSlots (properti)", () => {
  const timeArb = fc.integer({ min: 0, max: 23 * 60 }).map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  const ruleArb: fc.Arbitrary<WeeklyRule> = fc
    .tuple(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 22 * 60 }), fc.integer({ min: 15, max: 600 }))
    .map(([weekday, s, len]) => {
      const e = Math.min(s + len, 24 * 60);
      const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      return { weekday, start: hm(s), end: hm(e) };
    });
  const overrideArb: fc.Arbitrary<DateOverride> = fc
    .tuple(fc.integer({ min: 0, max: 14 }), fc.constantFrom<"blocked" | "extra">("blocked", "extra"), fc.boolean(), timeArb, fc.integer({ min: 15, max: 300 }))
    .map(([dayOffset, kind, allDay, start, len]) => {
      const date = addDays("2030-01-06", dayOffset);
      if (kind === "blocked" && allDay) return { date, kind };
      const s = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
      const e = Math.min(s + len, 24 * 60);
      const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      return { date, kind, start: hm(s), end: hm(Math.max(e, s + 1)) };
    });
  const busyArb: fc.Arbitrary<BusyRange> = fc
    .tuple(fc.integer({ min: -2 * 24 * 60, max: 16 * 24 * 60 }), fc.integer({ min: 15, max: 240 }))
    .map(([offMin, len]) => ({ start: new Date(NOW.getTime() + offMin * MIN), end: new Date(NOW.getTime() + (offMin + len) * MIN) }));

  const inputArb: fc.Arbitrary<SlotInput> = fc.record({
    now: fc.integer({ min: 0, max: 14 * 24 * 60 }).map((m) => new Date(NOW.getTime() + m * MIN)),
    timezone: fc.constantFrom<WorkspaceTimezone>("Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura"),
    durationMin: fc.constantFrom(15, 30, 45, 60, 90),
    bufferBeforeMin: fc.constantFrom(0, 5, 15, 30),
    bufferAfterMin: fc.constantFrom(0, 5, 15, 30),
    minNoticeMin: fc.constantFrom(0, 30, 60, 24 * 60),
    maxDaysAhead: fc.integer({ min: 1, max: 21 }),
    stepMin: fc.constantFrom(5, 15, 30, 60),
    rules: fc.array(ruleArb, { maxLength: 6 }),
    overrides: fc.array(overrideArb, { maxLength: 6 }),
    busy: fc.array(busyArb, { maxLength: 10 }),
  });

  /** Oracle independen: apakah [startMin, startMin+dur) lokal tercakup jam rutin/tambahan dan tidak diblokir? */
  function allowedByOracle(i: SlotInput, start: Date): boolean {
    const off = TIMEZONE_OFFSET_MIN[i.timezone];
    const date = localDateOf(start.getTime(), off);
    const local = new Date(start.getTime() + off * MIN);
    const sMin = local.getUTCHours() * 60 + local.getUTCMinutes();
    const eMin = sMin + i.durationMin;
    const hm = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
    const todays = i.overrides.filter((o) => o.date === date);
    const covering: [number, number][] = [
      ...i.rules.filter((r) => r.weekday === weekdayOf(date)).map((r) => [hm(r.start), hm(r.end)] as [number, number]),
      ...todays.filter((o) => o.kind === "extra").map((o) => [hm(o.start!), hm(o.end!)] as [number, number]),
    ];
    // Jendela gabungan bisa melintasi dua aturan yang bersambung: cek per-titik tiap menit (aman, kecil).
    for (let m = sMin; m < eMin; m++) if (!covering.some(([a, b]) => m >= a && m < b)) return false;
    for (const o of todays.filter((x) => x.kind === "blocked")) {
      if (!o.start) return false;
      if (sMin < hm(o.end!) && eMin > hm(o.start)) return false;
    }
    return true;
  }

  it("setiap slot memenuhi semua aturan", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const slots = computeSlots(input);
        const t = input.now.getTime();
        let prev = -Infinity;
        for (const s of slots) {
          const st = s.start.getTime();
          expect(st).toBeGreaterThan(prev); // terurut, tanpa duplikat
          prev = st;
          expect(s.end.getTime() - st).toBe(input.durationMin * MIN);
          expect(st).toBeGreaterThanOrEqual(t + input.minNoticeMin * MIN);
          expect(st).toBeLessThanOrEqual(t + input.maxDaysAhead * DAY);
          const lo = st - input.bufferBeforeMin * MIN;
          const hi = s.end.getTime() + input.bufferAfterMin * MIN;
          for (const b of input.busy) expect(b.start.getTime() < hi && b.end.getTime() > lo).toBe(false);
          expect(allowedByOracle(input, s.start)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("menambah booking tidak pernah menambah slot, hanya mengurangi", () => {
    fc.assert(
      fc.property(inputArb, busyArb, (input, extra) => {
        const before = new Set(computeSlots(input).map((s) => s.start.getTime()));
        const after = computeSlots({ ...input, busy: [...input.busy, extra] }).map((s) => s.start.getTime());
        for (const t of after) expect(before.has(t)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("deterministik: masukan sama, hasil sama", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(iso(computeSlots(input))).toEqual(iso(computeSlots(input)));
      }),
      { numRuns: 50 },
    );
  });
});
