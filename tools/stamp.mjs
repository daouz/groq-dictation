// 依每個 css／js 檔的內容雜湊更新 index.html 裡的 ?v=，避免 iPhone 在 GitHub Pages 快取期間混用新舊檔案。
// 用法：node tools/stamp.mjs        更新
//       node tools/stamp.mjs --check 只檢查，過期就以 1 結束
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(root, "index.html");
const html = fs.readFileSync(indexPath, "utf8");
const stale = [];
const out = html.replace(/((?:src|href)=")((?:js|css)\/[\w.-]+)\?v=(\w+)"/g, (m, pre, file, v) => {
  const h = crypto.createHash("sha1").update(fs.readFileSync(path.join(root, file))).digest("hex").slice(0, 8);
  if (h !== v) stale.push(file);
  return `${pre}${file}?v=${h}"`;
});
if (process.argv.includes("--check")) {
  if (stale.length) { console.log("版本號過期，請執行 node tools/stamp.mjs：" + stale.join("、")); process.exit(1); }
  console.log("版本號 OK");
} else {
  fs.writeFileSync(indexPath, out);
  console.log(stale.length ? "已更新：" + stale.join("、") : "版本號已是最新");
}
