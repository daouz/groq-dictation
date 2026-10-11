"use strict";
/* ================= 整理全文 ================= */
const ORG_PART = `你是筆記整理者。輸入是一段語音逐字稿（已初步校對），每段開頭有段號如 [#12]，部分段落附有〔系統警示〕。
請把這一部分整理成筆記小節，嚴格依照以下格式輸出：

### 小標
通順的段落或條列，保留所有具體資訊（數字、名稱、例子、步驟、條件、結論），刪掉重複與口語贅詞。
（來源：#3–#7）

（依主題分成數個 ### 小節，順序依原文）

@@要點
- 這部分最重要的 2–4 個重點，每條一句

@@待確認
- [#段號] 類型｜原文片段｜判斷理由｜建議：人工確認／重新辨識／刪除

規則：
1. 遇到語意不通、前後矛盾、疑似幻聽、疑似同音錯字、數字或專有名詞存疑的地方，不要自行猜測或硬改通順。在小節內文以〔?原文片段〕標註，並列入 @@待確認。
2. 疑似幻聽的判斷：與上下文主題無關的句子、影片片尾套語（訂閱、按讚、字幕提供、謝謝觀看）、重複循環、不像說話者會說的內容。疑似幻聽且與主題無關的句子不要寫進小節內文。
3. 類型只能用：語意不通、疑似幻聽、疑似錯字、數字或名詞存疑。建議只能用：人工確認、重新辨識、刪除。聽不清楚、懷疑辨識錯誤時建議「重新辨識」。
4. 附有〔系統警示〕的段落要特別檢查。
5. 不可杜撰原文沒有的資訊。使用台灣正體中文與全形標點。沒有待確認項目時，@@待確認 下寫「- 無」。`;
const ORG_SUM = `你是筆記編輯。輸入是一份長筆記各部分的「要點」與小節標題，依時間順序排列。
請只輸出以下 Markdown，不要加其他內容：

# 標題（依內容自擬，20 字內）

## 摘要
- 3–6 條，涵蓋全文最重要的內容

## 重點與待辦
- 關鍵結論、規則、行動事項；沒有就寫「- 無」

使用台灣正體中文與全形標點，不可杜撰。`;
async function chat(model, sys, user, maxTok, effort){
  for (let i = 0;; i++) {
    try {
      const j = await groq("chat/completions", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({
        model, temperature:0.3, reasoning_effort:effort, max_completion_tokens:maxTok, messages:[{role:"system",content:sys},{role:"user",content:user}]})});
      const c = j.choices?.[0];
      if (c?.finish_reason === "length") $("#orgMsg").textContent = "有一部分輸出被截斷，建議改用開發者方案或縮短內容";
      return (c?.message?.content || "").trim();
    } catch(e) {
      if (i >= 6 || e.status===401 || e.status===400 || e.status===413) throw e;
      const w = e.status===429 ? (e.wait || 8000*2**i) : 3000*2**i;
      $("#orgMsg").textContent = `${e.status===429?"等待 Groq 額度":"連線問題"}，${fmtWait(w)} 後重試…`;
      await sleep(w);
    }
  }
}
function orgLines(){
  return sorted().filter(g => g.status==="done" && g.text).map(g => {
    const f = [];
    if (!g.reviewed) { g.flags.filter(x => !/一致/.test(x)).forEach(x => f.push(x)); openIssues(g).forEach(i => f.push(i.type + "「" + i.quote + "」")); }
    return `[#${g.seq}]${f.length ? "〔系統警示：" + f.join("；") + "〕" : ""} ${g.text.trim()}`;
  });
}
function splitPart(md){
  const a = md.indexOf("@@要點"), b = md.indexOf("@@待確認");
  const body = (a >= 0 ? md.slice(0, a) : b >= 0 ? md.slice(0, b) : md).trim();
  const pts = a >= 0 ? md.slice(a + 4, b > a ? b : undefined).trim() : "";
  const todo = b >= 0 ? md.slice(b + 5).trim() : "";
  return {body, pts, todo};
}
function parseItems(text){
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\s*[-*]\s*\[?#(\d+)\]?\s*(.*)$/); if (!m) continue;
    const p = m[2].split(/[｜|]/).map(s => s.trim());
    out.push({seq:+m[1], type:p[0]||"", quote:p[1]||"", reason:p[2]||"", suggest:(p[3]||"").replace(/^建議[:：]\s*/, "")});
  }
  return out;
}
$("#orgBtn").onclick = async () => {
  readForm(); if (!S.key) return toast("請先設定 API key");
  const lines = orgLines(); if (!lines.length) return toast("還沒有完成的段落");
  const pending = [...segs.values()].filter(g => !/done|skip|err_tx|err_fx/.test(g.status)).length;
  const T = TIER(), btn = $("#orgBtn"); btn.disabled = true;
  try {
    const chunks = []; let b = "";
    for (const l of lines) { if (b && b.length + l.length > T.org) { chunks.push(b); b = ""; } b += (b ? "\n" : "") + l; }
    if (b) chunks.push(b);
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      $("#orgMsg").textContent = `整理第 ${i+1}/${chunks.length} 部分…`;
      parts.push(splitPart(await chat(S.orgModel, ORG_PART, chunks[i], T.orgTok, T.orgEffort)));
    }
    $("#orgMsg").textContent = "產生標題與摘要…";
    let sumIn = parts.map((p, i) => `【第 ${i+1} 部分】\n小節：${(p.body.match(/^###\s+.+$/gm)||[]).map(s=>s.replace(/^###\s+/,"")).join("、")}\n${p.pts}`).join("\n\n");
    if (sumIn.length > T.org * 1.5) sumIn = sumIn.slice(0, T.org * 1.5);
    const head = await chat(S.orgModel, ORG_SUM, sumIn, Math.min(T.orgTok, 2000), T.orgEffort);
    const items = parts.flatMap(p => parseItems(p.todo));
    const todoMd = items.length ? items.map(x => `- [#${x.seq}] ${x.type}｜${x.quote}｜${x.reason}｜建議：${x.suggest}`).join("\n") : "- 無";
    const final = `${head.trim()}\n\n## 內容整理\n\n${parts.map(p => p.body).join("\n\n")}\n\n## 待確認清單\n\n${todoMd}\n`;
    cur.organized = final; cur.orgItems = items; cur.orgAt = Date.now();
    segs.forEach(g => { if (g.orgNote) { g.orgNote = ""; computeRisk(g); touch(g); saveSeg(g); } });
    for (const x of items) { const g = segBySeq(x.seq); if (!g) continue; g.orgNote = [x.type, x.quote && "「"+x.quote+"」", x.reason, x.suggest && "建議："+x.suggest].filter(Boolean).join("　"); g.reviewed = false; touch(g); saveSeg(g, true); }
    await put("sessions", cur); driveDirty(cur.id); drawOrg(); render();
    $("#orgMsg").textContent = `完成（${clock(Date.now())}），待確認 ${items.length} 項` + (pending ? `；另有 ${pending} 段仍在處理，完成後可再整理一次` : "");
  } catch(e) { $("#orgMsg").textContent = "整理失敗：" + e.message; }
  finally { btn.disabled = false; }
};
function drawOrg(){
  if (!cur) return;
  $("#orgDoc").innerHTML = cur.organized ? md(cur.organized) : '<p class="empty">按「整理全文」把已完成的段落整理成筆記：標題、摘要、分節內容、重點與待辦，以及「待確認清單」（語意不通、疑似幻聽、建議重新辨識的地方都會附段號）。</p>';
  const it = cur.orgItems || [];
  const re = [...new Set(it.filter(x => /重新辨識/.test(x.suggest)).map(x => x.seq))].filter(s => { const g = segBySeq(s); return g && hasAudio(g); });
  $("#orgItems").innerHTML = it.length ? `<div class="card items"><div class="row tight"><strong>待確認 ${it.length} 項</strong><span class="sp"></span>${re.length ? `<button type="button" id="reAll">建議重新辨識的 ${re.length} 段改用 large-v3</button>` : ""}</div>${it.map(x => `<div class="item"><a class="ref" href="#" data-seq="${x.seq}">#${x.seq}</a><span class="chip">${esc(x.type)}</span><span class="q">${esc(x.quote)}</span><span class="note">${esc(x.reason)}</span><span class="note">建議：${esc(x.suggest)}</span></div>`).join("")}</div>` : "";
  const b = $("#reAll"); if (b) b.onclick = () => { re.forEach(s => { const g = segBySeq(s); if (g) redo(g, V3); }); toast(`已排入 ${re.length} 段重辨識，完成後請再整理一次`); };
}
function md(src){
  const lines = String(src).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])).split("\n"); let out = "", list = null;
  const inline = s => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/〔\?([^〕]*)〕/g, '<mark title="待確認">〔?$1〕</mark>')
    .replace(/\[?#(\d+)\]?/g, '<a class="ref" href="#" data-seq="$1">#$1</a>');
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const l of lines) {
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { close(); const n = Math.min(m[1].length, 3); out += `<h${n}>${inline(m[2])}</h${n}>`; }
    else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { close(); out += "<ul>"; list = "ul"; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+[.)、]\s*(.*)/))) { if (list !== "ol") { close(); out += "<ol>"; list = "ol"; } out += `<li>${inline(m[1])}</li>`; }
    else if (!l.trim()) close();
    else { close(); out += `<p>${inline(l)}</p>`; }
  }
  close(); return out;
}
$("#p-org").addEventListener("click", e => {
  const a = e.target.closest("a.ref"); if (!a) return; e.preventDefault();
  const g = segBySeq(+a.dataset.seq); if (g) openReview(g.id); else toast("找不到第 " + a.dataset.seq + " 段");
});

