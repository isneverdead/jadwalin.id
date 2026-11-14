import { ctx, shot, browser, pool } from "./lib.mjs";
const o = await ctx(1280, 800, "owner");
await shot(o, "/dashboard/bisnis-baru", "d8-template", { full: true, wait: 2500 });
await browser.close(); await pool.end();
