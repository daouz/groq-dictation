"use strict";
/* ================= 工作佇列（轉錄與修正分開並行，不阻塞錄音） ================= */
const lanes = {tx:{busy:new Set(), until:0, hits:0}, fx:{busy:new Set(), until:0, hits:0}};
let wakeTimer = null;
function setPaused(on, msg, reason){
  paused = on; pausedReason = on ? (reason||"user") : "";
  $("#pauseBtn").textContent = on ? "繼續處理" : "暫停處理";
  banner("pause", on ? (msg || "已暫停處理。錄音與存檔照常進行。") : "");
  if (!on) { lanes.tx.until = lanes.fx.until = 0; pump(); }
}
$("#pauseBtn").onclick = () => setPaused(!paused);
function pickBatch(list, now){
  const T = TIER(), out = []; let chars = 0;
  for (const g of list) {
    const ready = g.status==="transcribed" && g.nextAt <= now && !lanes.fx.busy.has(g.id) && !g.webPending;
    if (!ready) { if (out.length && g.status!=="skip") break; continue; }
    if (g.solo) { if (!out.length) out.push(g); break; }
    if (out.length && (chars + g.raw.length > T.batch || out.length >= 4)) break;
    out.push(g); chars += g.raw.length;
  }
  return out;
}
function pump(){
  clearTimeout(wakeTimer);
  if (!cur || !db) return;
  if (!S.key || paused) { renderStats(); return; }
  const T = TIER(), now = Date.now(), list = sorted(); let soon = Infinity;
  if (lanes.tx.until > now) soon = Math.min(soon, lanes.tx.until);
  else for (const g of list) {
    if (lanes.tx.busy.size >= T.tx) break;
    if (g.status!=="queued" || lanes.tx.busy.has(g.id)) continue;
    if (g.nextAt > now) { soon = Math.min(soon, g.nextAt); continue; }
    runTx(g);
  }
  if (lanes.fx.until > now) soon = Math.min(soon, lanes.fx.until);
  else while (lanes.fx.busy.size < T.fx) { const b = pickBatch(list, now); if (!b.length) break; runFx(b); }
  for (const g of list) if ((g.status==="queued" || g.status==="transcribed") && g.nextAt > now) soon = Math.min(soon, g.nextAt);
  if (soon < Infinity) wakeTimer = setTimeout(pump, Math.max(250, soon-now));
  renderStats();
}
function handleErr(g, e, lane){
  g.status = lane==="tx" ? "queued" : "transcribed"; g.err = e.message;
  if (e.drive) { g.nextAt = Date.now() + 30000; if (lane==="tx") lanes.tx.until = Date.now() + 30000; driveUI(); return; }
  if (e.status===401 || e.status===403) { setPaused(true, "API key 無效或沒有權限。請到「設定與保存」檢查後按「繼續處理」。錄音與存檔照常進行。", "key"); return; }
  if (e.status===429) {
    const L = lanes[lane]; L.hits++;
    const w = e.wait || Math.min(120000, 4000 * 2**Math.min(5, L.hits));
    L.until = Math.max(L.until, Date.now() + w);
    const daily = /per day|\bTPD\b|\bRPD\b|\bASD\b/i.test(e.message);
    if (lane === "tx" && (daily || w > 60000)) quotaFallback(w);
    else banner("rl-"+lane, `${lane==="tx"?"轉錄":"修正"}已達 Groq ${daily?"每日":"每分鐘"}額度，約 ${fmtWait(w)} 後自動繼續。錄音與存檔不受影響。`);
    return;
  }
  if (e.status===0 && !navigator.onLine) { lanes[lane].until = Date.now() + 5000; banner("net", "目前離線，恢復連線後會自動繼續。"); return; }
  g.tries++;
  const fatal = lane==="tx" && (e.status===400 || e.status===413);
  if (fatal || g.tries >= 6) { g.status = lane==="tx" ? "err_tx" : "err_fx"; return; }
  g.nextAt = Date.now() + Math.min(60000, 1500 * 2**g.tries);
}
async function runTx(g){
  const model = g.forceModel || S.asr;
  lanes.tx.busy.add(g.id); g.status = "transcribing"; g.err = ""; touch(g); render();
  try {
    const r = await transcribe(g, model);
    lanes.tx.hits = 0; banner("rl-tx"); banner("net");
    if (web.auto) { web.auto = false; if (!S.webasr && (web.on || web.r)) webStop(); toast("Groq 額度已恢復，開始補傳等待中的段落"); }
    g.alts = g.alts.filter(a => a.model !== model); g.alts.push(r);
    g.tries = 0; g.nextAt = 0;
    const oth = model===V3 ? TURBO : V3;
    const wantOther = !g.forceModel && !g.alts.some(a => a.model===oth) &&
      (S.escalate==="all" || (S.escalate==="v3" && (r.risk >= 2 || (!r.text && (g.voiced||0) >= 2))));
    applyBest(g);
    if (wantOther) { g.forceModel = oth; g.status = "queued"; }
    else { g.forceModel = null; if (g.raw) g.status = "transcribed"; else { g.status = "skip"; g.text = "（沒有辨識到語音內容）"; } }
  } catch(e) {
    if (e.noAudio) { g.status = "err_tx"; g.err = e.message; } else handleErr(g, e, "tx");
  } finally {
    lanes.tx.busy.delete(g.id); computeRisk(g); touch(g); saveSeg(g, true); render(); if (rvId===g.id) fillReview(false); pump();
  }
}
async function runFx(batch){
  for (const g of batch) { lanes.fx.busy.add(g.id); g.status = "fixing"; g.err = ""; touch(g); }
  render();
  try {
    const res = await fixBatch(batch);
    lanes.fx.hits = 0; banner("rl-fx"); banner("net");
    for (const g of batch) {
      const r = res.get(g.seq);
      if (!r) { g.status = "transcribed"; if (batch.length > 1) g.solo = true; else { g.tries++; g.nextAt = Date.now() + 3000; if (g.tries >= 4) { g.status="err_fx"; g.err="修正模型沒有回傳可用的結果"; } } continue; }
      let text = r.text, issues = r.issues;
      if (!text) { text = g.raw; issues.push({quote:g.raw.slice(0,15), type:"疑似幻聽", note:"修正模型判斷整段可疑", suggest:"", state:""}); }
      if (!g.edited) g.text = text;
      g.issues = issues; recheckIssues(g);
      g.status = "done"; g.tries = 0; g.nextAt = 0; g.solo = false;
    }
  } catch(e) {
    for (const g of batch) { handleErr(g, e, "fx"); if (batch.length > 1 && e.status===413) g.solo = true; }
  } finally {
    for (const g of batch) { lanes.fx.busy.delete(g.id); computeRisk(g); touch(g); saveSeg(g, true); }
    render(); if (rvId && batch.some(g=>g.id===rvId)) fillReview(false); pump();
  }
}
function redo(g, model){
  if (g.text && g.status==="done") pushHist(g, g.text);
  g.alts = model ? g.alts.filter(a=>a.model!==model) : [];
  g.forceModel = model || null; g.prefer = model || null;
  g.edited = false; g.reviewed = false; g.issues = []; g.orgNote = ""; g.tries = 0; g.nextAt = 0; g.err = ""; g.userSkip = false; g.solo = false;
  g.text = ""; g.status = hasAudio(g) ? "queued" : (g.raw ? "transcribed" : "err_tx");
  computeRisk(g); touch(g); saveSeg(g, true); render(); pump();
}
function refix(g){
  if (!g.raw) return toast("這段沒有原始辨識結果");
  if (g.text && g.status==="done") pushHist(g, g.text);
  g.edited = false; g.reviewed = false; g.issues = []; g.tries = 0; g.nextAt = 0; g.err = ""; g.solo = true; g.status = "transcribed";
  computeRisk(g); touch(g); saveSeg(g, true); render(); pump();
}
window.addEventListener("online", () => { banner("net"); lanes.tx.until = lanes.fx.until = 0; pump(); });

