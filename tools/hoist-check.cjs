// 找出：載入時（頂層、非延後執行）的呼叫，遞迴展開後會用到「較晚載入檔案」中宣告的函式
// `el.onclick = fn`、`addEventListener("x", fn)` 只是登記處理函式，點擊時才執行，不算載入時呼叫。
let acorn; try { acorn = require(process.env.ACORN || "/opt/node-tools/node_modules/acorn"); } catch { console.log("略過：找不到 acorn（可用 ACORN=路徑 指定）"); process.exit(0); }
const fs = require("fs");
const files = process.argv.slice(2);
const declFile = {}, bodies = {};
const asts = files.map(f => acorn.parse(fs.readFileSync(f, "utf8"), {ecmaVersion: "latest", sourceType: "script", locations: true}));
asts.forEach((ast, i) => ast.body.forEach(s => { if (s.type === "FunctionDeclaration") { declFile[s.id.name] = i; bodies[s.id.name] = s.body; } }));
// 收集節點中「立即執行」的呼叫：跳過函式運算式／箭頭函式本體（那些是回呼，稍後才跑）
function calls(node, deep, out = new Set()) {
  if (!node || typeof node.type !== "string") return out;
  if (!deep && (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "FunctionDeclaration")) return out;
  if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression" && /^on/.test(node.left.property.name || "") && node.right.type === "Identifier") return calls(node.left, false, out);
  if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.property.name === "addEventListener") { calls(node.callee, false, out); node.arguments.forEach(a => { if (a.type !== "Identifier") calls(a, false, out); }); return out; }
  if (node.type === "CallExpression" && node.callee.type === "Identifier") out.add(node.callee.name);
  if (node.type === "Identifier") out.add(node.name);   // 函式被當值傳出去也算（保守）
  for (const k in node) { if (k === "loc") continue; const v = node[k]; if (Array.isArray(v)) v.forEach(c => calls(c, false, out)); else if (v && typeof v.type === "string") calls(v, false, out); }
  return out;
}
let bad = 0;
asts.forEach((ast, i) => {
  for (const s of ast.body) {
    if (s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") continue;
    const seen = new Set(), stack = [...calls(s, true)].map(n => [n, [n]]);
    while (stack.length) {
      const [n, trail] = stack.pop();
      if (seen.has(n) || !(n in declFile)) continue; seen.add(n);
      if (declFile[n] > i) { bad++; console.log(`${files[i]}:${s.loc.start.line} 載入時會用到 ${files[declFile[n]]} 的 ${n}（路徑：${trail.join(" → ")}）`); continue; }
      for (const m of calls(bodies[n], true)) stack.push([m, [...trail, m]]);
    }
  }
});
console.log(bad ? `共 ${bad} 處：請把這些載入時的呼叫移到 99-boot.js，或把被呼叫的函式移到較前面的檔案` : "OK：沒有載入時跨到後面檔案的函式呼叫");
process.exit(bad ? 1 : 0);
