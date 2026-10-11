"use strict";
/* ================= Groq API ================= */
class ApiErr extends Error { constructor(m, status, wait){ super(m); this.status=status; this.wait=wait||0; } }
function parseWait(msg, hdr){
  let ms = 0; const ra = Number(hdr); if (isFinite(ra) && ra > 0) ms = ra*1000;
  const m = /try again in\s*(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?/i.exec(msg||"");
  if (m && (m[1]||m[2]||m[3])) ms = Math.max(ms, ((+m[1]||0)*3600 + (+m[2]||0)*60 + (+m[3]||0))*1000);
  const m2 = /try again in\s*([\d.]+)ms/i.exec(msg||""); if (m2) ms = Math.max(ms, +m2[1]);
  return ms ? ms + 500 : 0;
}
/* Groq 拒絕時記錄回饋：狀態碼、訊息與限額標頭（最近 50 筆，存 localStorage gd_rejects） */
function logReject(path, init, r, msg){
  let model = ""; try { model = init.body instanceof FormData ? init.body.get("model") : JSON.parse(init.body).model; } catch {}
  const h = n => r.headers.get(n) || "";
  const a = LS.get("rejects", []);
  a.push({t:Date.now(), path, model:model||"", status:r.status, msg:String(msg).slice(0, 300),
    resetReq:h("x-ratelimit-reset-requests"), resetTok:h("x-ratelimit-reset-tokens"), retryAfter:h("retry-after"),
    remReq:h("x-ratelimit-remaining-requests"), remTok:h("x-ratelimit-remaining-tokens"), limReq:h("x-ratelimit-limit-requests"), limTok:h("x-ratelimit-limit-tokens")});
  LS.set("rejects", a.slice(-50));
}
function rejectSummary(){
  const a = LS.get("rejects", []); if (!a.length) return "";
  return "最近被 Groq 拒絕：" + a.slice(-3).reverse().map(x => {
    const f = []; if (x.retryAfter) f.push("retry-after " + x.retryAfter + "s"); if (x.resetReq) f.push("每日請求重設 " + x.resetReq); if (x.resetTok) f.push("每分鐘 token 重設 " + x.resetTok);
    if (x.remReq) f.push("剩餘請求 " + x.remReq); if (x.remTok) f.push("剩餘 token " + x.remTok);
    return `${new Date(x.t).toLocaleTimeString("zh-TW", {hour12:false})} ${x.status} ${x.model || x.path}｜${x.msg.slice(0, 120)}${f.length ? "｜" + f.join("、") : ""}`;
  }).join("；");
}
async function groq(path, init){
  let r;
  try { r = await fetch("https://api.groq.com/openai/v1/"+path, {...init, headers:{Authorization:"Bearer "+S.key, ...(init.headers||{})}}); }
  catch { throw new ApiErr("網路連線失敗", 0); }
  if (!r.ok) {
    let m = "HTTP " + r.status; try { const j = await r.json(); m = j.error?.message || m; } catch {}
    logReject(path, init, r, m);
    throw new ApiErr(m, r.status, r.status===429 ? parseWait(m, r.headers.get("retry-after")) : 0);
  }
  return r.json();
}

/* ================= 轉錄與幻聽偵測 ================= */
const HALLU = /(請不吝|點贊|點讚|按讚|訂閱|轉發|打賞|字幕由|字幕製作|字幕提供|明鏡與點點|感謝觀看|謝謝觀看|謝謝收看|謝謝大家收看|Amara|中文字幕|獨播劇場|YoYo|下期再見|下次再見|本節目|使用繁體字|中文錄音|台灣的中文)/i;
const REPEAT = /(.{2,12}?)\1{3,}/;
function joinParts(arr){ let s=""; for (const t of arr){ if (s && /[A-Za-z0-9]$/.test(s) && /^[A-Za-z0-9]/.test(t)) s+=" "; s+=t; } return s; }
function whisperPrompt(){ const v = vocabList(); return v.length ? v.join("、").slice(0, 200) : ""; }
function analyze(j, dur, model, prompt){
  const list = Array.isArray(j.segments) ? j.segments : null;
  const kept=[], dropped=[];
  if (list) {
    for (const s of list) {
      const t = String(s.text||"").trim(); if (!t) continue;
      const nsp = typeof s.no_speech_prob==="number" ? s.no_speech_prob : 0;
      const lp = typeof s.avg_logprob==="number" ? s.avg_logprob : null;
      const cr = typeof s.compression_ratio==="number" ? s.compression_ratio : 1;
      const d = Math.max(0.1, (s.end||0) - (s.start||0));
      const bad = (nsp > 0.6 && (lp ?? 0) < -0.7) || (HALLU.test(t) && t.length < 40) || (cr > 2.6 && REPEAT.test(t));
      (bad ? dropped : kept).push({t, lp, d, cr});
    }
  } else { const t = String(j.text||"").trim(); if (t) kept.push({t, lp:null, d:dur||1, cr:1}); }
  const text = joinParts(kept.map(k=>k.t));
  const flags=[]; let risk=0;
  const withLp = kept.filter(k=>k.lp!=null), tw = withLp.reduce((s,k)=>s+k.d,0);
  const lp = tw ? withLp.reduce((s,k)=>s+k.lp*k.d,0)/tw : null;
  if (dropped.length) { flags.push(`已濾除 ${dropped.length} 句疑似幻聽`); risk += 1; }
  if (lp != null && lp < -1.1) { flags.push("信心很低"); risk += 2; }
  else if (lp != null && lp < -0.8) { flags.push("信心偏低"); risk += 1; }
  if (Math.max(1, ...kept.map(k=>k.cr)) > 2.2 || REPEAT.test(text)) { flags.push("重複循環"); risk += 2; }
  if (HALLU.test(text)) { flags.push("片尾套語"); risk += 3; }
  if (prompt && prompt.length >= 6 && text.includes(prompt.slice(0, Math.min(12, prompt.length)))) { flags.push("詞彙表被當成內容"); risk += 3; }
  if (dur > 3 && text.replace(/\s/g,"").length / dur > 9) { flags.push("字數異常多"); risk += 1; }
  const lowParts = kept.filter(k => k.lp != null && k.lp < -0.9).map(k=>k.t).slice(0, 6);
  return {model, text, lp, risk, flags, dropped:dropped.map(d=>d.t), lowParts};
}
async function transcribe(g, model){
  const a = await segAudio(g);
  const fd = new FormData();
  fd.append("file", a.blob, `seg-${g.seq}.${a.ext}`);
  fd.append("model", model);
  if (S.lang) fd.append("language", S.lang);
  fd.append("temperature", "0");
  fd.append("response_format", "verbose_json");
  const p = whisperPrompt(); if (p) fd.append("prompt", p);
  const j = await groq("audio/transcriptions", {method:"POST", body:fd});
  return analyze(j, g.dur || ((g.end||0)-(g.start||0)), model, p);
}
function sim(a, b){
  const n = s => s.replace(/[\s\p{P}\p{S}]/gu, "");
  a = n(a); b = n(b);
  if (!a && !b) return 1; if (!a || !b) return 0;
  if (a.length < 2 || b.length < 2) return a===b ? 1 : 0;
  const bg = s => { const m = new Map(); for (let i=0;i<s.length-1;i++){ const k=s.slice(i,i+2); m.set(k,(m.get(k)||0)+1); } return m; };
  const A=bg(a), B=bg(b); let inter=0; A.forEach((v,k)=>{ inter += Math.min(v, B.get(k)||0); });
  return 2*inter / (a.length-1 + b.length-1);
}
function applyBest(g){
  const A = g.alts.filter(a=>a.text);
  let best = null;
  if (g.prefer) best = A.find(a=>a.model===g.prefer) || null;
  if (!best && A.length) best = A.slice().sort((x,y)=>(x.risk-y.risk) || ((y.model===V3)-(x.model===V3)))[0];
  g.agree = null;
  if (!best) { g.raw=""; g.flags=[]; g.asrRisk=0; g.dropped=[]; g.lowParts=[]; return; }
  g.raw = best.text; g.model = best.model; g.lp = best.lp; g.dropped = best.dropped; g.lowParts = best.lowParts;
  const flags = [...best.flags]; let risk = best.risk;
  const other = g.alts.find(a => a.model !== best.model);
  if (other) {
    if (!other.text) { flags.push(MNAME(other.model)+" 沒聽到內容"); risk += 2; }
    else { const s = sim(best.text, other.text); g.agree = s;
      if (s < 0.5) { flags.push("兩模型差異大"); risk += 2; }
      else if (s >= 0.8) { flags.push("兩模型一致"); risk = Math.max(0, risk-1); } }
  }
  if (g.web === "" && g.raw.replace(/[\s\p{P}]/gu, "").length >= 4) { flags.push("Apple 沒聽到內容"); risk += 2; }
  g.flags = flags; g.asrRisk = risk;
}

/* ================= 逐段修正（gpt-oss，批次） ================= */
const FIX_SYS = `你是台灣正體中文的逐字稿校對員。輸入是語音辨識（Whisper）的一或多個連續片段，每段標有段號。辨識結果可能含簡體字、同音錯字、缺標點，也可能含「幻聽」：音檔裡沒有說、模型自己生成的句子。
每一段分別處理：
1. 轉成台灣正體中文與台灣慣用詞（視頻→影片、質量→品質、軟件→軟體）；英文專有名詞保留原文。
2. 只修正把握很高的同音錯字；加上全形標點（，。、？！：「」）並依語意斷句；刪除純口頭贅字（嗯、呃、那個那個）。
3. 不要摘要、不要改寫語氣、不要補寫原文沒有的內容；不要把內容合併或搬到別段。
4. 下列情況在 text 保留原樣，不要自行刪除或硬改通順，並列入 issues：
   疑似幻聽：與前後文無關、影片片尾套語（訂閱、按讚、字幕提供、謝謝觀看）、重複循環、突然出現的人名或網址。
   語意不通：句子斷裂、前後矛盾、看不出意思。
   疑似錯字：可能是同音錯字但你不確定怎麼改。
   數字或名詞存疑：數字、價格、人名、專有名詞可能聽錯。
「系統警示」與「低信心句」是辨識系統的提示，請特別檢查這些地方。
只輸出 JSON：
{"segments":[{"seq":段號,"text":"校正後文字","issues":[{"quote":"text 中逐字存在的片段，15 字以內","type":"疑似幻聽|語意不通|疑似錯字|數字或名詞存疑","note":"10 字內理由","suggest":"建議改成的文字；建議刪除填空字串；不確定填 null"}]}]}
每個輸入段號都要輸出一筆；沒有問題時 issues 為 []。`;
const SEAM = "疑似接縫重複";
const TYPES = ["疑似幻聽","語意不通","疑似錯字","數字或名詞存疑", SEAM];
function cleanIssues(arr){
  return (Array.isArray(arr) ? arr : []).filter(i => i && typeof i.quote==="string" && i.quote.trim()).slice(0, 12).map(i => ({
    quote: i.quote.trim(), type: TYPES.includes(i.type) ? i.type : "語意不通", note: String(i.note||"").slice(0, 60),
    suggest: typeof i.suggest==="string" ? i.suggest : null, state:""}));
}
function parseFix(s, batch){
  const out = new Map(); const t = String(s||"").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let o = null; try { o = JSON.parse(t); } catch { const m = t.match(/\{[\s\S]*\}/); if (m) try { o = JSON.parse(m[0]); } catch {} }
  let arr = null;
  if (o && Array.isArray(o.segments)) arr = o.segments;
  else if (o && typeof o.text === "string") arr = [{...o, seq:batch[0].seq}];
  if (!arr) { if (batch.length===1 && t && !t.startsWith("{")) out.set(batch[0].seq, {text:t, issues:[]}); return out; }
  for (const x of arr) {
    if (!x || typeof x.text !== "string") continue;
    let seq = Number(String(x.seq ?? "").replace(/[^\d]/g, ""));
    if (batch.length===1 && !batch.some(g=>g.seq===seq)) seq = batch[0].seq;
    if (!batch.some(g=>g.seq===seq)) continue;
    out.set(seq, {text:x.text.trim(), issues:cleanIssues(x.issues)});
  }
  return out;
}
async function fixBatch(batch, noJson){
  const T = TIER(), list = sorted();
  const prev = list.filter(x => x.seq < batch[0].seq && x.status==="done" && x.text).slice(-1)[0];
  let u = "";
  if (prev) u += "【前文，只供參考，不要輸出】\n" + prev.text.slice(-150) + "\n\n";
  const v = vocabList(); if (v.length) u += "【詞彙表】" + v.join("、") + "\n\n";
  for (const g of batch) {
    u += `【#${g.seq}】\n`;
    const warn = g.flags.filter(f => !/一致/.test(f)); if (warn.length) u += "系統警示：" + warn.join("、") + "\n";
    if (g.lowParts.length) u += "低信心句：" + g.lowParts.join(" / ") + "\n";
    if (g.dropped.length) u += "已濾除（不要放回）：" + g.dropped.join(" / ") + "\n";
    if (g.web != null) u += "Apple 辨識（準確度較低，僅供比對同音字）：" + (g.web || "（沒有聽到內容）") + "\n";
    u += "原始：" + g.raw + "\n\n";
  }
  const body = {model:S.fixModel, temperature:0.2, reasoning_effort:"low", max_completion_tokens:T.fixTok,
    messages:[{role:"system", content:FIX_SYS}, {role:"user", content:u.trim()}]};
  if (!noJson) body.response_format = {type:"json_object"};
  let j;
  try { j = await groq("chat/completions", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)}); }
  catch(e){ if (e.status===400 && !noJson && /json|response_format/i.test(e.message)) return fixBatch(batch, true); throw e; }
  logUsage(j, batch.length, T.fixTok);
  return parseFix(j.choices?.[0]?.message?.content || "", batch);
}
/* 記錄修正呼叫的 token 用量（最近 100 筆，存 localStorage），供評估批次大小與 FIX_SYS 長度 */
function logUsage(j, n, max){
  const u = j.usage; if (!u) return;
  const a = LS.get("usage", []);
  a.push({t:Date.now(), n, max, p:u.prompt_tokens||0, c:u.completion_tokens||0, r:u.completion_tokens_details?.reasoning_tokens||0, f:j.choices?.[0]?.finish_reason||""});
  LS.set("usage", a.slice(-100));
}
function usageSummary(){
  const a = LS.get("usage", []); if (!a.length) return "";
  const avg = k => Math.round(a.reduce((s,x)=>s+x[k],0)/a.length), cut = a.filter(x => x.f === "length").length;
  return `修正用量（最近 ${a.length} 次）：平均每次 ${avg("n")} 段、輸入 ${avg("p")}、輸出 ${avg("c")}（其中推理 ${avg("r")}）tokens；輸出被截斷 ${cut} 次。`;
}


/* 0.5 秒重疊在話中切段時，下一段開頭可能重複上一段結尾 1–8 字：只標記，不自動刪 */
const SEAM_PUNCT = /[\s，。、？！：；,.?!]/;
function seamCheck(g){
  if (!g || g.srcId || g.edited || !g.text || g.status !== "done" || (g.issues||[]).some(i => i.type === SEAM)) return;
  const prev = segs.get(g.sid + ":" + String(g.seq - 1).padStart(5, "0"));
  if (!prev || prev.srcId || prev.status !== "done" || !prev.text) return;
  const gt = g.text.replace(new RegExp("^" + SEAM_PUNCT.source + "+"), ""), pt = prev.text.replace(new RegExp(SEAM_PUNCT.source, "g"), "");
  for (let k = Math.min(8, gt.length - 1); k >= 2; k--) {
    const h = gt.slice(0, k);
    if (SEAM_PUNCT.test(h) || !pt.endsWith(h)) continue;
    g.issues.push({quote:h, type:SEAM, note:`與 #${prev.seq} 結尾相同`, suggest:"", state:""});
    computeRisk(g); return;
  }
}
