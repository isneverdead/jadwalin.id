import { chromium } from "/Users/fariz/Documents/PORTFOLIO/Jadwalin.id/apps/web/node_modules/@playwright/test/index.mjs";
import pg from "/Users/fariz/Documents/PORTFOLIO/Jadwalin.id/apps/web/node_modules/pg/lib/index.js";
import fs from "node:fs";
export const BASE = "http://localhost:3000";
export const PASSWORD = "Demo-Kantor-Rahayu-2026!";
export const OUT = "/Users/fariz/Documents/PORTFOLIO/Jadwalin.id/promo/screenshots";
export const pool = new pg.Pool({ connectionString: "postgres://jadwalin:jadwalin@localhost:5433/jadwalin" });
export const users = {
  owner: ["Rahayu Wulandari", "rahayu@kantorrahayu.id"], staf: ["Bagas Pratama", "bagas@kantorrahayu.id"],
  dewi: ["Dewi Lestari", "dewi.lestari@gmail.com"], hendra: ["Hendra Kusuma", "hendra.kusuma@outlook.com"],
};
export const browser = await chromium.launch();
export async function ctx(width, height, who, o = {}) {
  const sf = who ? `/Users/fariz/Documents/PORTFOLIO/Jadwalin.id/promo/build/state/${who}.json` : null;
  const c = await browser.newContext({ ...(sf && fs.existsSync(sf) ? { storageState: sf } : {}), baseURL: BASE, viewport: { width, height }, deviceScaleFactor: 2, colorScheme: o.scheme || "light", isMobile: width < 600, locale: "id-ID", timezoneId: "Asia/Jakarta" });
  await c.route("http://localhost:9100/**", async (route) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const res = await route.fetch(); await route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
  });
  const p = await c.newPage();
  if (who && !fs.existsSync(sf)) { await login(p, users[who][1], o.password); await c.storageState({ path: sf }); }
  return p;
}
export async function login(p, email, password = PASSWORD) {
  for (let t = 0; t < 8; t++) { if (t > 0) await p.waitForTimeout(20000);
    await p.goto("/masuk"); await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(3000);
    await p.getByLabel("Email").fill(email); await p.getByLabel("Kata sandi").fill(password);
    await p.getByRole("button", { name: "Masuk" }).click();
    try { await p.waitForURL((u) => !u.pathname.startsWith("/masuk"), { waitUntil: "commit", timeout: 8000 }); await p.waitForTimeout(3000); return; } catch {}
  }
  throw new Error("login gagal " + email);
}
export async function shot(p, path, name, opts = {}) {
  if (path) { await p.goto(path); await p.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {}); await p.waitForTimeout(opts.wait ?? 1200); }
  await p.addStyleTag({ content: "nextjs-portal,[data-nextjs-toast],[data-nextjs-dev-tools-button]{display:none!important} .cf-turnstile{display:none!important}" });
  if (opts.prep) await opts.prep(p);
  await p.screenshot({ path: `${opts.dir || OUT}/${name}.png`, fullPage: !!opts.full, clip: opts.clip });
  console.log(name);
}
export async function settle(page, name) {
  await Promise.all([page.waitForResponse((r) => r.request().method() === "POST"), page.getByRole("button", { name }).click()]);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
}
