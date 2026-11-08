import { describe, expect, it } from "vitest";
import { canTransition } from "./status";

describe("canTransition", () => {
  it("staf bisa menyelesaikan tiket terbuka", () => {
    expect(canTransition("open", "resolved", "staff")).toBe(true);
  });
  it("tiket closed tidak bisa dibuka lagi oleh siapa pun", () => {
    expect(canTransition("closed", "open", "staff")).toBe(false);
    expect(canTransition("closed", "open", "client")).toBe(false);
  });
  it("klien tidak bisa memindahkan tiket ke in_progress", () => {
    expect(canTransition("open", "in_progress", "client")).toBe(false);
  });
  it("klien bisa membuka ulang tiket resolved", () => {
    expect(canTransition("resolved", "open", "client")).toBe(true);
  });
  it("klien bisa menutup tiketnya dari status aktif mana pun, tapi tidak menyelesaikannya atau menutup yang sudah ditutup", () => {
    for (const s of ["open", "in_progress", "waiting_client", "resolved"] as const) expect(canTransition(s, "closed", "client")).toBe(true);
    expect(canTransition("closed", "closed", "client")).toBe(false);
    expect(canTransition("open", "resolved", "client")).toBe(false);
  });
});
