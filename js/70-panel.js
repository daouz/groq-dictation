"use strict";
/* ================= 審閱面板 ================= */
let rvId = null, rvUrl = "", taSnap = null;
const ta = $("#rvText"), au = $("#rvAudio");
au.addEventListener("error", async () => {
  if (!au.getAttribute("src") || au._wav || !au._seg) return;
  const g = segs.get(au._seg); if (!g) return;
  au._wav = true; $("#rvNoAudio").hidden = false; $("#rvNoAudio").textContent = "轉換音檔格式中…";
  try { const url = await wavUrl(g); if (au._seg !== g.id) return; au.src = url; au.playbackRate = Number($("#rvRate .on")?.dataset.rate || 1); $("#rvNoAudio").hidden = true; }
  catch(e) { $("#rvNoAudio").textContent = "這段音檔無法播放：" + e.message; }
});
function openReview(id){
  const g = segs.get(id); if (!g) return;
  const changed = rvId !== id; if (changed && rvId) plStop(false); rvId = id;
  $("#rv").hidden = false; document.body.classList.add("rv-open");
  fillReview(true);
  if (changed) loadReviewAudio(g);
  render();
  const row = document.querySelector(`.seg[data-id="${CSS.escape(id)}"]`); row?.scrollIntoView({block:"nearest"});
}
function closeReview(){
  if (!rvId) return;
  if (typeof plStop === "function") plStop(false);
  commitTa(); rvId = null; $("#rv").hidden = true; document.body.classList.remove("rv-open");
  au.pause(); if (rvUrl) { URL.revokeObjectURL(rvUrl); rvUrl = ""; } au.removeAttribute("src"); render();
}
async function loadReviewAudio(g){
  au.pause(); if (rvUrl) { URL.revokeObjectURL(rvUrl); rvUrl = ""; } au.removeAttribute("src");
  $("#rvNoAudio").hidden = hasAudio(g); au.hidden = !hasAudio(g); $("#rvRate").hidden = !hasAudio(g);
  if (!hasAudio(g)) return;
  try {
    if (wavCache.has(g.id)) { au._wav = true; au.src = wavCache.get(g.id); }
    else { const b = await rawPlayBlob(g); if (rvId !== g.id) return; rvUrl = URL.createObjectURL(b); au._wav = false; au.src = rvUrl; }
    au._seg = g.id; au.playbackRate = Number($("#rvRate .on")?.dataset.rate || 1); au.loop = $("#rvLoop").checked;
    if (S.autoplay) au.play().catch(()=>{});
  } catch(e){ $("#rvNoAudio").hidden = false; $("#rvNoAudio").textContent = "無法載入音檔：" + e.message; }
}
function fillReview(full){
  const g = segs.get(rvId); if (!g) return closeReview();
  const rvList = sorted().filter(needsReview);
  $("#rvTitle").textContent = `#${g.seq}`;
  $("#rvPos").textContent = `${clock(g.at)}${g.dur ? " · "+Number(g.dur).toFixed(1)+" 秒" : ""} · 待審閱 ${rvList.length} 段`;
  const [lab, cls] = STAT[g.status] || [g.status, ""];
  $("#rvChips").innerHTML = `<span class="chip ${cls}">${lab}</span>${g.model ? `<span class="chip">${MNAME(g.model)}</span>` : ""}${confChip(g)}${g.flags.map(flagChip).join("")}${g.reviewed ? '<span class="chip d">已確認</span>' : ""}${g.err && g.status.startsWith("err") ? `<span class="note err">${esc(g.err)}</span>` : ""}`;
  const val = g.status==="skip" && !g.userSkip ? "" : (g.text || g.raw || "");
  if (full || (document.activeElement !== ta && ta.value !== val)) { ta.value = val; }
  ta.placeholder = g.status==="queued"||g.status==="transcribing" ? "辨識中…" : g.status==="transcribed"||g.status==="fixing" ? "修正中…（可先直接修改）" : "";
  // 問題清單
  let h = "";
  if (g.orgNote) h += `<div class="iss hl-s"><div><b>整理時標註</b> ${esc(g.orgNote)}</div><div class="row tight"><button type="button" data-org="clear">已處理</button></div></div>`;
  g.issues.forEach((i,k) => {
    h += `<div class="iss ${TYPECLS[i.type]||"hl-s"}${i.state?" done":""}"><div><b>${esc(i.type)}</b>「${esc(i.quote)}」${i.note?` <span class="note">${esc(i.note)}</span>`:""}${i.suggest?` → 「${esc(i.suggest)}」`:i.suggest===""?" → 建議刪除":""}${i.state?` <span class="note">（${i.state==="fixed"?"已處理":"保留原文"}）</span>`:""}</div>`;
    if (!i.state) h += `<div class="row tight">${i.suggest!=null?`<button type="button" data-iss="${k}" data-op="acc">${i.suggest===""?"刪除這句":"採用建議"}</button>`:""}${i.suggest!==""?`<button type="button" data-iss="${k}" data-op="del">刪除這句</button>`:""}<button type="button" data-iss="${k}" data-op="ign">保留原文</button><button type="button" data-iss="${k}" data-op="find">選取</button></div>`;
    h += `</div>`;
  });
  $("#rvIssues").innerHTML = h;
  // 原始辨識
  $("#rvAlts").innerHTML = g.alts.length ? g.alts.map(a => `<div class="alt"><div class="rvchips"><span class="chip">${MNAME(a.model)}</span>${a.lp!=null?`<span class="chip">信心 ${a.lp.toFixed(2)}</span>`:""}${a.flags.map(flagChip).join("")}${a.model===g.model?'<span class="chip d">目前採用</span>':(a.text?`<button type="button" data-alt="${esc(a.model)}">改用這版重新修正</button>`:"")}</div><div class="rawtxt">${esc(a.text) || "（沒有內容）"}</div></div>`).join("")
    + (g.agree!=null ? `<p class="note">兩模型相似度 ${(g.agree*100).toFixed(0)}%</p>` : "") : '<p class="note">還沒有辨識結果。</p>';
  $("#rvDropped").innerHTML = (g.web != null || g.webPending ? `<div class="alt"><div class="rvchips"><span class="chip">Apple 辨識</span><span class="note">${g.webSrc === "play" ? "播放時辨識" : "錄音時同步辨識"}，只供比對</span></div><div class="rawtxt">${g.webPending ? "比對中…" : esc(g.web) || "（Apple 沒有聽到內容）"}</div></div>` : "") + (g.dropped.length ? `<div class="alt"><span class="note">自動濾除的疑似幻聽（不會出現在逐字稿）</span><div class="rawtxt">${g.dropped.map(esc).join("<br>")}</div></div>` : "");
  $("#rvHist").innerHTML = g.history.length ? `<div class="alt"><span class="note">修改紀錄</span>${g.history.map((x,k)=>`<div class="hist"><span class="note">${clock(x.t)}</span><span class="t">${esc(x.text)}</span><button type="button" data-hist="${k}">還原</button></div>`).join("")}</div>` : "";
  const all = sorted(), ix = all.findIndex(x => x.id === g.id), pv = all[ix-1], nx = all[ix+1];
  const pvTxt = x => `#${x.seq}　${(x.text || x.raw || x.web || "（沒有文字）").slice(0, 60)}`;
  $("#rvPrevPv").hidden = !pv; if (pv) $("#rvPrevPv").textContent = "▲ 上一段　" + pvTxt(pv);
  $("#rvNextPv").hidden = !nx; if (nx) $("#rvNextPv").textContent = "▼ 下一段　" + pvTxt(nx) + "（在這裡繼續往上滑也能切換）";
  $("#rvSkip").textContent = g.status==="skip" ? (g.userSkip ? "放回逐字稿" : "重新辨識這段") : "從逐字稿移除";
  $("#rvV3").disabled = $("#rvTurbo").disabled = !hasAudio(g);
}
function editText(g, text, snap){
  if (snap != null && snap !== text) pushHist(g, snap);
  g.text = text; g.edited = true; recheckIssues(g); touch(g); saveSeg(g); render();
}
function commitTa(){ const g = segs.get(rvId); if (g && taSnap != null && taSnap !== ta.value) { pushHist(g, taSnap); saveSeg(g, true); } taSnap = null; }
ta.addEventListener("focus", () => { taSnap = ta.value; });
ta.addEventListener("input", () => { const g = segs.get(rvId); if (!g) return; editText(g, ta.value); clearTimeout(ta._h); ta._h = setTimeout(() => fillReviewSoft(), 300); });
ta.addEventListener("blur", () => { commitTa(); fillReviewSoft(); });
function fillReviewSoft(){ if (rvId) fillReview(false); }
$("#rvIssues").addEventListener("click", e => {
  const g = segs.get(rvId); if (!g) return;
  if (e.target.closest("[data-org]")) { g.orgNote = ""; computeRisk(g); touch(g); saveSeg(g, true); fillReview(false); render(); return; }
  const b = e.target.closest("button[data-iss]"); if (!b) return;
  const i = g.issues[+b.dataset.iss]; if (!i) return;
  const t = ta.value;
  if (b.dataset.op === "find") { const p = t.indexOf(i.quote); if (p >= 0) { ta.focus(); ta.setSelectionRange(p, p + i.quote.length); } else toast("文字裡找不到這段"); return; }
  if (g.text !== t) { editText(g, t, g.text); }
  applyIssueOp(g, +b.dataset.iss, b.dataset.op); ta.value = g.text || ""; fillReview(false); render();
});
$("#rvAlts").addEventListener("click", e => {
  const b = e.target.closest("button[data-alt]"); if (!b) return; const g = segs.get(rvId); if (!g) return;
  g.prefer = b.dataset.alt; applyBest(g); refix(g); fillReview(true);
});
$("#rvHist").addEventListener("click", e => {
  const b = e.target.closest("button[data-hist]"); if (!b) return; const g = segs.get(rvId); if (!g) return;
  const h = g.history[+b.dataset.hist]; if (!h) return;
  const old = g.text; editText(g, h.text, old); ta.value = h.text; fillReview(false);
});
function confirmSeg(){
  const g = segs.get(rvId); if (!g) return;
  commitTa();
  if (g.status==="done" || g.status==="skip") { g.reviewed = true; g.orgNote = ""; touch(g); saveSeg(g, true); render(); }
  else toast("這段還在處理中，先跳到下一段");
  step(1, true);
}
function step(dir, reviewOnly){
  const list = sorted(); const i = list.findIndex(x => x.id===rvId);
  const seq = dir > 0 ? [...list.slice(i+1), ...list.slice(0, Math.max(0,i))] : [...list.slice(0, Math.max(0,i)).reverse(), ...list.slice(i+1).reverse()];
  const nx = seq.find(needsReview) || (reviewOnly ? null : (dir > 0 ? list[i+1] : list[i-1]));
  if (nx) { commitTa(); openReview(nx.id); }
  else if (reviewOnly) { toast("沒有待審閱的段落了"); closeReview(); }
}
$("#rvOk").onclick = confirmSeg;
$("#rvNext").onclick = () => { const list = sorted(), i = list.findIndex(x=>x.id===rvId); if (list[i+1]) openReview(list[i+1].id); };
$("#rvPrev").onclick = () => { const list = sorted(), i = list.findIndex(x=>x.id===rvId); if (i > 0) openReview(list[i-1].id); };
$("#rvClose").onclick = closeReview;
/* 實驗：用喇叭播放這段，同時讓 Apple／瀏覽器語音辨識從麥克風聽 */
let pl = null;
function plMsg(t){ $("#rvListenMsg").textContent = t; }
// iPhone／iPad：開麥克風時 iOS 會切成通話模式（聲音改走聽筒），網頁無法改回喇叭，所以不提供
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
$("#rvListenRow").hidden = IS_IOS || !(window.SpeechRecognition || window.webkitSpeechRecognition);
function resetAudioSession(){ try { if (navigator.audioSession) navigator.audioSession.type = "auto"; } catch {} }
function plStop(save){
  if (!pl) return; const st = pl; pl = null;
  try { st.r.abort(); } catch {} au.removeEventListener("ended", st.onEnd); resetAudioSession();
  $("#rvListen").textContent = "播放並用 Apple 聽（實驗）";
  if (!save) { plMsg("已取消"); return; }
  setTimeout(() => {
    const g = segs.get(st.id); if (!g) return;
    const text = st.finals.join("") + (st.interim || "");
    if (!text) { plMsg("Apple 沒有聽到內容。可能被手機的回音消除濾掉了，試試把音量調大，或改用耳機以外的外放。"); return; }
    g.web = text; g.webV = 2; g.webSrc = "play";
    if (g.alts.length) applyBest(g); computeRisk(g); touch(g); saveSeg(g, true); render(); if (rvId === g.id) fillReview(false);
    plMsg("Apple 聽到：" + text.slice(0, 60) + (text.length > 60 ? "…" : "") + "（已存成這段的 Apple 版本）");
  }, 1200);
}
$("#rvListen").onclick = async () => {
  if (pl) return plStop(false);
  const SRc = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SRc) return plMsg("這個瀏覽器不支援語音辨識，請用 Safari 或 Chrome");
  if (rec.on) return plMsg("錄音中無法使用，請先停止錄音");
  const g = segs.get(rvId); if (!g || !hasAudio(g)) return plMsg("這段沒有音檔");
  const r = new SRc(); r.lang = "zh-TW"; r.continuous = true; r.interimResults = true;
  const st = {id:g.id, r, finals:[], interim:"", onEnd:null}; pl = st;
  r.onresult = e => { let it = ""; for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0]?.transcript || ""; if (e.results[i].isFinal) st.finals.push(t); else it += t; } st.interim = it; plMsg("聽到：" + (st.finals.join("") + it).slice(-40)); };
  r.onerror = e => { if (pl === st) { plMsg("語音辨識錯誤：" + e.error); plStop(false); } };
  st.onEnd = () => plStop(true);
  au.addEventListener("ended", st.onEnd);
  try { r.start(); } catch(e) { pl = null; return plMsg("無法啟動語音辨識：" + e.message); }
  $("#rvListen").textContent = "停止";
  plMsg("聆聽中…請開喇叭、音量調大");
  au.loop = false; au.playbackRate = 1; au.currentTime = 0;
  setTimeout(() => au.play().catch(err => { plMsg("無法播放：" + err.message); plStop(false); }), 400);
};
function rvStep(d){ const list = sorted(), i = list.findIndex(x => x.id === rvId), t = list[i + d]; if (!t) return; commitTa(); openReview(t.id); $("#rv").scrollTop = 0; }
$("#rvPrevPv").onclick = () => rvStep(-1);
$("#rvNextPv").onclick = () => rvStep(1);
(() => {   // 在面板頂端再往下拉 → 上一段；在底部再往上滑 → 下一段
  const rv = $("#rv"); let y0 = null, edge = 0, wheelAcc = 0, wheelT = 0;
  const atTop = () => rv.scrollTop <= 0, atBottom = () => rv.scrollTop + rv.clientHeight >= rv.scrollHeight - 2;
  rv.addEventListener("touchstart", e => { if (e.target.closest("textarea")) { y0 = null; return; } y0 = e.touches[0].clientY; edge = atTop() ? -1 : atBottom() ? 1 : 0; }, {passive:true});
  rv.addEventListener("touchmove", e => {
    if (y0 == null) return; const dy = e.touches[0].clientY - y0;
    if (!edge) { edge = atTop() && dy > 0 ? -1 : atBottom() && dy < 0 ? 1 : 0; if (edge) y0 = e.touches[0].clientY; return; }
    const pull = edge === 1 ? -dy : dy;
    rv.classList.toggle("pull-next", edge === 1 && pull > 70); rv.classList.toggle("pull-prev", edge === -1 && pull > 70);
  }, {passive:true});
  rv.addEventListener("touchend", () => {
    if (rv.classList.contains("pull-next")) rvStep(1); else if (rv.classList.contains("pull-prev")) rvStep(-1);
    rv.classList.remove("pull-next", "pull-prev"); y0 = null; edge = 0;
  });
  rv.addEventListener("wheel", e => {
    if (e.target.closest("textarea")) return;
    const t = performance.now(); if (t - wheelT > 400) wheelAcc = 0; wheelT = t;
    if ((e.deltaY > 0 && atBottom()) || (e.deltaY < 0 && atTop())) { wheelAcc += e.deltaY; if (Math.abs(wheelAcc) > 400) { rvStep(wheelAcc > 0 ? 1 : -1); wheelAcc = 0; } }
    else wheelAcc = 0;
  }, {passive:true});
})();
$("#rvRefix").onclick = () => { const g = segs.get(rvId); if (g) { refix(g); fillReview(true); } };
$("#rvV3").onclick = () => { const g = segs.get(rvId); if (g) { redo(g, V3); fillReview(true); } };
$("#rvTurbo").onclick = () => { const g = segs.get(rvId); if (g) { redo(g, TURBO); fillReview(true); } };
$("#rvSkip").onclick = () => {
  const g = segs.get(rvId); if (!g) return;
  if (g.status === "skip") { if (g.userSkip) { g.userSkip = false; g.status = g.text ? "done" : "transcribed"; touch(g); saveSeg(g, true); render(); pump(); } else redo(g); }
  else if (/done|err_tx|err_fx/.test(g.status)) { commitTa(); g.userSkip = true; g.status = "skip"; g.reviewed = true; touch(g); saveSeg(g, true); render(); }
  else return toast("處理中的段落無法移除");
  fillReview(true);
};
$("#rvRate").addEventListener("click", e => { const b = e.target.closest("button[data-rate]"); if (!b) return; $$("#rvRate button").forEach(x => x.classList.toggle("on", x===b)); au.playbackRate = Number(b.dataset.rate); });
$("#rvLoop").onchange = e => { au.loop = e.target.checked; };
$("#reviewBtn").onclick = () => { const g = sorted().find(needsReview); if (g) openReview(g.id); else toast("目前沒有待審閱的段落"); };
document.addEventListener("keydown", e => {
  if (!rvId) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Escape") { e.preventDefault(); closeReview(); }
  else if (mod && e.key === "Enter") { e.preventDefault(); confirmSeg(); }
  else if (mod && (e.key === "k" || e.key === "K")) { e.preventDefault(); if (au.src) au.paused ? au.play().catch(()=>{}) : au.pause(); }
});

/* ================= 全文尋找與取代 ================= */
function frCount(){ const a = $("#frFind").value; if (!a) { $("#frCount").textContent = ""; return; } let n = 0; segs.forEach(g => { if (g.text) n += g.text.split(a).length - 1; }); $("#frCount").textContent = `符合 ${n} 處`; }
$("#frFind").addEventListener("input", frCount);
$("#frGo").onclick = () => {
  const a = $("#frFind").value, b = $("#frRep").value; if (!a) return toast("請輸入要尋找的文字");
  let n = 0;
  segs.forEach(g => { if (!g.text || !g.text.includes(a)) return; const c = g.text.split(a).length - 1; const old = g.text; editText(g, old.split(a).join(b), old); saveSeg(g, true); n += c; });
  if ($("#frVocab").checked && b && !vocabList().includes(b)) { S.vocab = S.vocab ? S.vocab + "、" + b : b; $("#vocab").value = S.vocab; LS.set("settings", S); }
  toast(`已取代 ${n} 處`); frCount(); if (rvId) fillReview(true);
};

/* ================= 合併稿 ================= */
function mergedParas(){
  const paras = []; let curP = [], len = 0;
  for (const g of sorted()) {
    if (g.status !== "done" || !g.text) continue;
    g.text.trim().split(/\n+/).forEach((x, i) => { if (i > 0 && curP.length) { paras.push(curP); curP = []; len = 0; } curP.push({g, t:x}); len += x.length; });
    if (len > 260 && /[。！？」]$/.test(g.text.trim())) { paras.push(curP); curP = []; len = 0; }
  }
  if (curP.length) paras.push(curP);
  return paras;
}
const mergedText = () => mergedParas().map(p => p.map(x => x.t).join("")).join("\n\n");
let mergedHTML = "";
function drawMerged(){
  if ($("#p-merged").hidden) return;
  const flag = $("#mFlag").checked, paras = mergedParas();
  const pend = sorted().filter(g => !/done|skip|err_tx|err_fx/.test(g.status) && (g.raw || g.web || g.status === "queued" || g.status === "transcribing"));
  const html = (paras.length ? paras.map(p => "<p>" + p.map(x => `<span class="ms${flag && needsReview(x.g) ? " flag" : ""}" data-id="${esc(x.g.id)}">${esc(x.t)}</span>`).join("") + "</p>").join("") : (pend.length ? "" : '<p class="empty">還沒有完成的段落。</p>'))
    + (pend.length ? `<p class="pendp">${pend.map(g => `<span class="ms pend" data-id="${esc(g.id)}">${esc(g.raw || g.web || "")}${g.raw || g.web ? "" : `<i>#${g.seq} ${g.status === "transcribing" ? "轉錄中…" : "等待轉錄…"}</i>`}</span>`).join("")}<span class="note">（處理中，完成後會校正）</span></p>` : "");
  if (html === mergedHTML) return;
  const nb = nearBottom(); mergedHTML = html; $("#mergedDoc").innerHTML = html;
  if (rec.on && nb) window.scrollTo({top:document.documentElement.scrollHeight});
}
$("#mFlag").onchange = drawMerged;
$$(".tabs button").forEach(b => b.addEventListener("click", () => { mergedHTML = ""; drawMerged(); }));
$("#mergedDoc").addEventListener("click", e => { const s = e.target.closest(".ms"); if (s) openReview(s.dataset.id); });

