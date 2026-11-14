import { chromium } from "/Users/fariz/Documents/PORTFOLIO/Jadwalin.id/apps/web/node_modules/@playwright/test/index.mjs";
import fs from "node:fs";
const BASE = "http://localhost:3000";
const OUT = "/Users/fariz/Documents/PORTFOLIO/Jadwalin.id/promo/screenshots";
const { SLUG, PASSWORD, users, manage } = JSON.parse(fs.readFileSync("/Users/fariz/Documents/PORTFOLIO/Jadwalin.id/promo/build/state/seed.json", "utf8"));
const scheme = process.env.SCHEME || "light";
const b = await chromium.launch();
async function ctx(width, height, who) {
  const c = await b.newContext({ baseURL: BASE, viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme, isMobile: width < 600, locale: "id-ID", timezoneId: "Asia/Jakarta" });
  const p = await c.newPage();
  if (who) {
    for (let t = 0; t < 4; t++) {
      await p.goto("/masuk"); await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(3000);
      await p.getByLabel("Email").fill(users[who][1]); await p.getByLabel("Kata sandi").fill(PASSWORD);
      await p.getByRole("button", { name: "Masuk" }).click();
      try { await p.waitForURL((u) => !u.pathname.startsWith("/masuk"), { waitUntil: "commit", timeout: 8000 }); await p.waitForTimeout(3000); break; } catch {}
    }
  }
  return p;
}
async function shot(p, path, name, opts = {}) {
  await p.goto(path); await p.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {}); await p.waitForTimeout(opts.wait ?? 1200);
  await p.addStyleTag({ content: "nextjs-portal,[data-nextjs-toast],[data-nextjs-dev-tools-button]{display:none!important}" });
  if (opts.prep) await opts.prep(p);
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: !!opts.full, clip: opts.clip });
  console.log(name);
}
const fillForm = async (p) => {
  const v = await p.locator('select[name="startsAt"] option:not([disabled])').evaluateAll((e) => e.map((x) => x.value));
  await p.locator('select[name="startsAt"]').selectOption(v[9]);
  await p.getByLabel("Nama", { exact: true }).fill("Sari Anggraini");
  await p.getByLabel(/^Email/).fill("sari.anggraini@gmail.com");
  await p.getByLabel(/^Nomor HP/).fill("0813-7788-4521");
  await p.getByLabel("Topik").fill("Konsultasi pajak penghasilan freelance");
  await p.getByLabel(/^Catatan/).fill("Ingin memahami kewajiban lapor SPT sebagai freelancer.");
  await p.addStyleTag({ content: ".cf-turnstile{display:none!important}" });
};
const staf = await ctx(780, 560, "owner");
await shot(staf, `/w/${SLUG}`, "d1-dashboard", { full: true });
await shot(staf, `/w/${SLUG}/tiket`, "d2-daftar-tiket", { full: true });
await shot(staf, `/w/${SLUG}/tiket/1`, "d3-detail-tiket", { full: true });
await shot(staf, `/w/${SLUG}/jadwal`, "d4-jadwal", { full: true });
const klien = await ctx(780, 560, "dewi");
await shot(klien, `/jadwal-saya/${SLUG}`, "d5-portal-klien", { full: true });
await shot(klien, `/jadwal-saya/${SLUG}/tiket/1`, "d6-tiket-klien", { full: true });
const m = await ctx(390, 844, null);
await shot(m, `/${SLUG}`, "m1-halaman-publik", { full: true });
await shot(m, `/${SLUG}/konsultasi`, "m2-pilih-slot", { full: true, wait: 6000, prep: fillForm });
await shot(m, manage.replace(BASE, ""), "m3-kelola-booking", { clip: { x: 0, y: 0, width: 390, height: 360 } });
await b.close();
