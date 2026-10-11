// 冒煙測試：以 iPhone 13 尺寸開啟頁面，模擬麥克風錄兩段、切換各檢視、開審閱面板。
// 有 pageerror、左右捲動、或沒錄到段落就以非 0 結束。Groq 與 Google 的網路請求都會被攔下，不會真的送出。
// 用法：node tools/smoke.mjs [截圖輸出資料夾]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PW = process.env.PW || "/opt/node22/lib/node_modules/playwright/index.mjs";
const CHROME = process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const { chromium, devices } = await import(PW);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.argv[2] || "";

const TYPES = {".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".svg":"image/svg+xml", ".webmanifest":"application/manifest+json"};
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname.replace(/\/$/, "/index.html")));
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {"Content-Type": TYPES[path.extname(p)] || "application/octet-stream"}); fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({executablePath: CHROME, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]});
const ctx = await browser.newContext({...devices["iPhone 13"], permissions: ["microphone"]});
const page = await ctx.newPage();
const errors = [], problems = [];
page.on("pageerror", e => errors.push(String(e.stack || e)));
await page.route(/api\.groq\.com/, r => r.fulfill({status: 401, contentType: "application/json", body: '{"error":{"message":"test"}}'}));
await page.route(/accounts\.google\.com|googleapis\.com/, r => r.abort());

const tap = sel => page.$eval(sel, e => e.click());
const shot = async name => { if (shots) await page.screenshot({path: path.join(shots, name + ".png")}); };
const hscroll = async where => { const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]); if (w[0] > w[1]) problems.push(`${where}：有左右捲動 ${w[0]} > ${w[1]}`); };

await page.goto(url);
await page.waitForFunction(() => typeof db !== "undefined" && db && cur, null, {timeout: 10000});
await shot("01-load"); await hscroll("載入");

await page.evaluate(() => { $("#settings").hidden = false; });
await page.fill("#key", "gsk_test");
await page.evaluate(() => { const t = $("#thr"); t.min = "0"; t.value = "0.0001"; });
await page.evaluate(() => { $("#settings").hidden = true; });
await tap("#recBtn");
await page.waitForTimeout(2500);
await tap("#cutBtn");
await page.waitForTimeout(2000);
await shot("02-recording"); await hscroll("錄音中");
await tap("#recBtn");
await page.waitForFunction(() => segs.size >= 2, null, {timeout: 8000}).catch(() => problems.push("錄音後段落少於 2 段"));
await page.waitForFunction(() => paused && pausedReason === "key", null, {timeout: 8000}).catch(() => problems.push("沒有走到轉錄（應收到模擬的 401 並暫停）"));
await page.waitForTimeout(500);

for (const v of ["issues", "read", "list"]) { await tap(`#viewSw button[data-view="${v}"]`); await page.waitForTimeout(200); await hscroll("檢視 " + v); }
for (const t of ["merged", "org", "segs"]) { await tap(`.tabs button[data-tab="${t}"]`); await page.waitForTimeout(200); await hscroll("分頁 " + t); }
const first = await page.$("#segList .seg .txt");
if (first) { await first.evaluate(e => e.click()); await page.waitForTimeout(400); await shot("03-review"); await hscroll("審閱面板"); }
else problems.push("列表沒有段落可開啟");
await tap("#setBtn"); await page.waitForTimeout(300); await shot("04-settings"); await hscroll("設定");

const info = await page.evaluate(() => ({segs: segs.size, statuses: [...segs.values()].map(g => g.status), paused, banners: Object.keys(banners)}));
await browser.close(); server.close();
console.log(JSON.stringify({info, errors, problems}, null, 1));
process.exit(errors.length || problems.length ? 1 : 0);
