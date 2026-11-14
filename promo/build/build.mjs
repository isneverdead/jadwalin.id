import { chromium } from "/Users/fariz/Documents/PORTFOLIO/Jadwalin.id/apps/web/node_modules/@playwright/test/index.mjs";
const b = await chromium.launch(); const p = await b.newPage();
await p.goto("file:///Users/fariz/Documents/PORTFOLIO/Jadwalin.id/promo/build/promo.html"); await p.waitForLoadState("networkidle");
await p.pdf({ path: "/Users/fariz/Documents/PORTFOLIO/Jadwalin.id/promo/jadwalin-promo.pdf", format: "A4", printBackground: true, preferCSSPageSize: true });
await b.close();
