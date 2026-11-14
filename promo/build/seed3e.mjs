import { ctx, shot, browser, pool } from "./lib.mjs";
import fs from "node:fs";
const bg = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e6eefa"/><stop offset="1" stop-color="#cfdcf0"/></linearGradient></defs><rect width="900" height="675" fill="url(#g)"/><ellipse cx="450" cy="540" rx="260" ry="26" fill="#0b172233"/>`;
const body = (lens) => `<rect x="190" y="230" width="520" height="270" rx="34" fill="#0f1c2b"/><rect x="215" y="195" width="140" height="50" rx="14" fill="#0f1c2b"/><rect x="520" y="200" width="90" height="42" rx="10" fill="#1d3552"/><rect x="190" y="230" width="150" height="270" rx="34" fill="#16273b"/><circle cx="450" cy="365" r="${lens ? 128 : 96}" fill="#09121c"/><circle cx="450" cy="365" r="${lens ? 104 : 74}" fill="#1b3a5e"/><circle cx="450" cy="365" r="${lens ? 70 : 46}" fill="#0b2442"/><circle cx="420" cy="335" r="${lens ? 18 : 12}" fill="#9ec2ee99"/><circle cx="660" cy="262" r="10" fill="#1d5fa8"/>`;
const lensSvg = `<rect x="250" y="210" width="400" height="300" rx="40" fill="#0f1c2b"/><rect x="250" y="260" width="400" height="30" fill="#1d3552"/><rect x="250" y="330" width="400" height="60" fill="#1d5fa8"/><rect x="250" y="430" width="400" height="26" fill="#1d3552"/><ellipse cx="650" cy="360" rx="34" ry="150" fill="#09121c"/><ellipse cx="650" cy="360" rx="22" ry="110" fill="#1b3a5e"/>`;
const imgs = [body(false), body(true), lensSvg];
const rp = await (await browser.newContext({ viewport: { width: 900, height: 675 } })).newPage();
for (const [i, s] of imgs.entries()) { await rp.setContent(`<body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="900" height="675">${bg}${s}</svg></body>`); await rp.screenshot({ path: `state/foto/p${i}.png` }); }
const o = await ctx(1280, 900, "owner");
await o.goto("/w/demo-bintang-kamera/produk"); await o.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}); await o.waitForTimeout(2000);
for (let i = 0; i < 3; i++) {
  await o.goto("/w/demo-bintang-kamera/produk"); await o.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}); await o.waitForTimeout(1500);
  const art = o.locator("article").nth(i);
  await art.locator("summary", { hasText: "Ubah produk" }).click();
  await art.locator('input[type="file"]').setInputFiles(`state/foto/p${i}.png`);
  await o.waitForFunction((n) => !!document.querySelectorAll("article")[n].querySelector('input[name="imageFileId"]')?.value, i, { timeout: 30000 });
  await Promise.all([o.waitForResponse((r) => r.request().method() === "POST"), art.getByRole("button", { name: "Simpan perubahan" }).click()]);
  await o.waitForTimeout(2000);
}
// bukti bayar sewa
const url = fs.readFileSync("state/rent-url.txt", "utf8").trim().replace("http://localhost:3000", "");
const rc = await (await browser.newContext({ viewport: { width: 420, height: 560 }, deviceScaleFactor: 2 })).newPage();
await rc.setContent(`<body style="font-family:Helvetica;margin:0;background:#f4f6f8"><div style="margin:24px;background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 12px #0002"><div style="color:#0a8f4d;font-weight:700;font-size:18px">✔ Transfer berhasil</div><div style="color:#666;font-size:12px;margin-top:4px">9 Nov 2026 · 14.12 WIB</div><hr style="border:0;border-top:1px solid #eee;margin:16px 0"><div style="font-size:12px;color:#888">Jumlah</div><div style="font-size:28px;font-weight:700">Rp315.000</div><div style="font-size:12px;color:#888;margin-top:14px">Ke</div><div style="font-size:15px">BNI 0865290417<br>Rahayu Wulandari</div><div style="font-size:12px;color:#888;margin-top:14px">Dari</div><div style="font-size:15px">Rizky Aditya</div><div style="font-size:12px;color:#888;margin-top:14px">Berita</div><div style="font-size:15px">Rizky Aditya - Sewa Sony A7 III 20-22 Nov</div></div></body>`);
await rc.screenshot({ path: "state/bukti-sewa.png" });
const g = await ctx(390, 844, null);
await g.goto(url); await g.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {}); await g.waitForTimeout(2500);
await g.locator('input[type="file"]').setInputFiles("state/bukti-sewa.png");
await g.getByRole("button", { name: "Kirim bukti pembayaran" }).click();
await g.waitForTimeout(6000);
console.log((await g.locator("body").innerText()).slice(0, 300));
await browser.close(); await pool.end();
