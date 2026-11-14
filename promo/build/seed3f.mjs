import { ctx, browser, pool } from "./lib.mjs";
const o = await ctx(1280, 900, "owner");
await o.goto("/w/demo-bintang-kamera/pembayaran"); await o.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}); await o.waitForTimeout(2000);
await Promise.all([o.waitForResponse((r) => r.request().method() === "POST"), o.getByRole("button", { name: /Konfirmasi lunas/ }).first().click()]);
await o.waitForTimeout(2500);
console.log((await pool.query("select p.status, p.subject_type from payments p join workspaces w on w.id=p.workspace_id where w.slug in ('demo-bintang-kamera','demo-pajak-rahayu')")).rows);
await browser.close(); await pool.end();
