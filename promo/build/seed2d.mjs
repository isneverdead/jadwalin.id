import { ctx, shot, browser, pool, settle, OUT } from "./lib.mjs";
import fs from "node:fs";
const url = fs.readFileSync("state/dp-url.txt", "utf8").trim().replace("http://localhost:3000", "");
// bukti transfer contoh (gambar) dibuat dari HTML sederhana
const rp = await (await browser.newContext({ viewport: { width: 420, height: 560 }, deviceScaleFactor: 2 })).newPage();
await rp.setContent(`<body style="font-family:Helvetica;margin:0;background:#f4f6f8"><div style="margin:24px;background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 12px #0002"><div style="color:#0a8f4d;font-weight:700;font-size:18px">✔ Transfer berhasil</div><div style="color:#666;font-size:12px;margin-top:4px">11 Nov 2026 · 09.41 WIB</div><hr style="border:0;border-top:1px solid #eee;margin:16px 0"><div style="font-size:12px;color:#888">Jumlah</div><div style="font-size:28px;font-weight:700">Rp150.000</div><div style="font-size:12px;color:#888;margin-top:14px">Ke</div><div style="font-size:15px">BCA 7340118255<br>Rahayu Wulandari</div><div style="font-size:12px;color:#888;margin-top:14px">Dari</div><div style="font-size:15px">Maya Kusumawati</div><div style="font-size:12px;color:#888;margin-top:14px">Berita</div><div style="font-size:15px">Maya Kusumawati - DP Review SPT</div></div></body>`);
await rp.screenshot({ path: "state/bukti.png" });
const g = await ctx(390, 844, null);
await shot(g, url, "m4-bayar", { full: true, wait: 2500 });
await g.locator('input[type="file"]').setInputFiles("state/bukti.png");
await g.getByRole("button", { name: "Kirim bukti pembayaran" }).click();
await g.waitForTimeout(6000);
await shot(g, null, "m5-bukti-terkirim", { full: true });
const o = await ctx(1280, 800, "owner");
await shot(o, "/w/demo-pajak-rahayu/pembayaran", "d7-pembayaran", { full: true, wait: 2500 });
await browser.close(); await pool.end();
