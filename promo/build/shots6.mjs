import { ctx, shot, browser, pool } from "./lib.mjs";
const g = await ctx(390, 844, null);
await shot(g, "/booking/4TTK0g7SYIE65IqaFDPm_NaAPGuzOelf", "m3-kelola-booking", { clip: { x: 0, y: 0, width: 390, height: 600 }, prep: (p) => p.evaluate(() => window.scrollTo(0, 0)) });
await browser.close(); await pool.end();
