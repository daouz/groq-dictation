// 儲存層測試（IndexedDB v4：段落音檔獨立存在 segaudio）
// 1. 先用舊格式（v3，音檔 ab 存在段落記錄裡）建資料，再開新版：開啟工作階段後音檔要逐段完整搬到 segaudio、段落記錄不再含音檔
// 2. 狀態改變存檔時只寫段落、不重寫音檔；新錄的段落音檔只寫一次
// 3. 「釋放本機空間」只刪該段音檔記錄；重新整理後其他段音檔仍在
// 4. 刪除工作階段時連音檔一起刪
// 用法：node tools/store-test.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PW = process.env.PW || "/opt/node22/lib/node_modules/playwright/index.mjs";
const CHROME = process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const { chromium, devices } = await import(PW);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TYPES = {".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".svg":"image/svg+xml", ".webmanifest":"application/manifest+json"};
const server = http.createServer((req, res) => {
  const pn = new URL(req.url, "http://x").pathname;
  if (pn === "/__blank") { res.writeHead(200, {"Content-Type": "text/html"}); return res.end("<!doctype html><title>blank</title>"); }
  const p = path.join(root, decodeURIComponent(pn.replace(/\/$/, "/index.html")));
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {"Content-Type": TYPES[path.extname(p)] || "application/octet-stream"}); fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({executablePath: CHROME, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]});
const ctx = await browser.newContext({...devices["iPhone 13"], permissions: ["microphone"]});
const page = await ctx.newPage();
const errors = [], fails = [], ok = [];
page.on("pageerror", e => errors.push(String(e.stack || e)));
await page.route(/api\.groq\.com/, r => r.fulfill({status: 401, contentType: "application/json", body: '{"error":{"message":"test"}}'}));
await page.route(/accounts\.google\.com|googleapis\.com/, r => r.abort());
const check = (cond, msg) => (cond ? ok : fails).push(msg);
const tap = sel => page.$eval(sel, e => e.click());
const ready = () => page.waitForFunction(() => typeof db !== "undefined" && db && cur, null, {timeout: 10000});
// 直接讀 IndexedDB（不經過程式的 put/get）
const raw = store => page.evaluate(s => new Promise((res, rej) => { const t = db.transaction(s, "readonly"); const q = t.objectStore(s).getAll(); t.oncomplete = () => res(q.result.map(r => ({...r, ab: r.ab ? r.ab.byteLength : undefined}))); t.onerror = () => rej(t.error); }), store);

// ---- 1. 建立 v3 舊資料 ----
const SIZES = [16044, 32044, 48044];   // 三段不同長度的 WAV
await page.goto(url + "__blank");
await page.evaluate(sizes => new Promise((res, rej) => {
  const r = indexedDB.open("groq-dictation", 3);
  r.onupgradeneeded = () => { const d = r.result;
    d.createObjectStore("sessions", {keyPath: "id"});
    for (const s of ["segs", "sources", "master"]) d.createObjectStore(s, {keyPath: "id"}).createIndex("sid", "sid"); };
  r.onsuccess = () => { const d = r.result, t = d.transaction(["sessions", "segs"], "readwrite");
    t.objectStore("sessions").put({id: "s1", name: "舊資料", created: Date.now(), organized: "", orgItems: []});
    sizes.forEach((n, i) => { const ab = new ArrayBuffer(n); new Uint8Array(ab).fill(i + 1);
      t.objectStore("segs").put({id: "s1:0000" + (i + 1), sid: "s1", seq: i + 1, at: Date.now(), dur: 1, status: "done", raw: "第" + (i + 1) + "段", text: "第" + (i + 1) + "段", ext: "wav", flags: [], issues: [], ab, abType: "audio/wav", blob: null}); });
    t.oncomplete = () => { d.close(); localStorage.setItem("gd_cur", '"s1"'); res(); }; t.onerror = () => rej(t.error); };
  r.onerror = () => rej(r.error);
}), SIZES);

await page.goto(url); await ready();
// 舊格式在開啟工作階段時逐段搬移（migrateAudio），等它做完
await page.waitForFunction(() => new Promise(res => { const t = db.transaction("segaudio", "readonly"); const q = t.objectStore("segaudio").count(); t.oncomplete = () => res(q.result === 3); }), null, {timeout: 10000}).catch(() => {});
const ver = await page.evaluate(() => db.version);
check(ver === 4, `升級後 DB 版本為 4（實際 ${ver}）`);
let segsRaw = await raw("segs"), audRaw = await raw("segaudio");
check(segsRaw.length === 3 && segsRaw.every(r => r.ab === undefined && !r.abType), "段落記錄不再含音檔");
check(audRaw.length === 3 && SIZES.every((n, i) => audRaw.find(a => a.id === "s1:0000" + (i + 1))?.ab === n), "三段音檔完整搬進 segaudio（位元組數相同）");
const mem = await page.evaluate(() => sorted().map(g => g.blob ? g.blob.size : null));
check(JSON.stringify(mem) === JSON.stringify(SIZES), `記憶體中的音檔大小正確 ${JSON.stringify(mem)}`);
const bytes = await page.evaluate(async () => [...new Uint8Array(await segBySeq(2).blob.arrayBuffer())].slice(0, 4).join(","));
check(bytes === "2,2,2,2", "音檔內容正確");

// ---- 2. 存檔只寫段落 ----
await page.evaluate(() => {
  window.__puts = {};
  const orig = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...a) { window.__puts[this.name] = (window.__puts[this.name] || 0) + 1; return orig.apply(this, a); };
});
await page.evaluate(async () => { for (const g of sorted()) { g.reviewed = true; touch(g); await saveSeg(g, true); } });
let puts = await page.evaluate(() => window.__puts);
check(puts.segs === 3 && !puts.segaudio, `改狀態存檔 3 次：段落寫入 ${puts.segs || 0} 次、音檔寫入 ${puts.segaudio || 0} 次`);

// 新錄兩段：音檔各寫一次，之後再存檔不重寫
await page.evaluate(() => { window.__puts = {}; $("#settings").hidden = false; });
await page.fill("#key", "gsk_test");
await page.evaluate(() => { $("#settings").hidden = true; });
await tap("#recBtn"); await page.waitForTimeout(2200); await tap("#cutBtn"); await page.waitForTimeout(1800); await tap("#recBtn");
await page.waitForFunction(() => segs.size >= 5, null, {timeout: 8000}).catch(() => {});
await page.waitForTimeout(1500);
const recN = await page.evaluate(() => sorted().filter(g => g.seq > 3 && g.blob).length);
puts = await page.evaluate(() => window.__puts);
check(recN >= 2 && puts.segaudio === recN, `新錄 ${recN} 段，音檔寫入 ${puts.segaudio || 0} 次（應各一次）`);
await page.evaluate(async () => { window.__puts = {}; for (const g of sorted()) { touch(g); await saveSeg(g, true); } });
puts = await page.evaluate(() => window.__puts);
check(!puts.segaudio, `再存檔一次：音檔寫入 ${puts.segaudio || 0} 次`);

// ---- 3. 釋放本機空間 ----
await page.evaluate(() => { const g = segBySeq(1); g.driveAudioId = "drive-x"; });
await tap("#delAudio"); await tap("#yesDA"); await page.waitForTimeout(500);
audRaw = await raw("segaudio"); segsRaw = await raw("segs");
check(!audRaw.some(a => a.id === "s1:00001") && audRaw.some(a => a.id === "s1:00002"), "只刪除已備份那段的本機音檔");
check(segsRaw.find(r => r.id === "s1:00001")?.driveAudioId === "drive-x", "段落資料保留（含 Drive 音檔 id）");
await page.reload(); await ready();
const after = await page.evaluate(() => sorted().map(g => g.blob ? g.blob.size : null));
check(after[0] === null && after[1] === SIZES[1] && after[2] === SIZES[2], `重新整理後音檔狀態正確 ${JSON.stringify(after.slice(0, 3))}`);

// ---- ZIP 匯出再匯入：音檔要完整 ----
const before = await page.evaluate(() => sorted().filter(g => g.blob).map(g => g.seq + ":" + g.blob.size));
const [dl] = await Promise.all([page.waitForEvent("download", {timeout: 15000}), page.evaluate(() => exportZip())]);
const zipPath = await dl.path();
await page.setInputFiles("#zipIn", zipPath);
await page.waitForFunction(() => cur && cur.id !== "s1", null, {timeout: 10000}).catch(() => {});
await page.waitForTimeout(500);
const imp = await page.evaluate(() => ({sid: cur.id, list: sorted().filter(g => g.blob).map(g => g.seq + ":" + g.blob.size)}));
audRaw = await raw("segaudio");
check(imp.sid !== "s1" && JSON.stringify(imp.list) === JSON.stringify(before), `ZIP 匯入後音檔一致 ${JSON.stringify(imp.list)}`);
check(audRaw.filter(a => a.sid === imp.sid).length === before.length, "匯入的音檔已寫進 segaudio");
await page.evaluate(() => switchSession("s1")); await page.waitForTimeout(300);

// ---- 4. 刪除工作階段 ----
await tap("#delSess"); await tap("#yesDel"); await page.waitForTimeout(800);
audRaw = await raw("segaudio"); segsRaw = await raw("segs");
check(!audRaw.some(a => a.sid === "s1") && !segsRaw.some(r => r.sid === "s1"), "刪除工作階段時段落與音檔都清除");

await browser.close(); server.close();
console.log(ok.map(m => "✓ " + m).join("\n"));
if (fails.length) console.log(fails.map(m => "✗ " + m).join("\n"));
if (errors.length) console.log("pageerror：\n" + errors.join("\n"));
console.log(fails.length || errors.length ? "儲存測試未通過" : "儲存測試通過");
process.exit(fails.length || errors.length ? 1 : 0);
