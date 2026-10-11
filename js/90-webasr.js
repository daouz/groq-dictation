"use strict";
/* ================= Apple／瀏覽器語音辨識（錄音時同步比對） ================= */
function quotaFallback(w){
  const n = [...segs.values()].filter(g => g.status === "queued").length;
  const SRok = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  banner("rl-tx", `Groq 轉錄額度用完，約 ${fmtWait(w)} 後自動恢復並補傳（目前等待 ${n} 段，錄音照常保存）。` + (SRok ? (rec.on ? "已改用 Apple 語音辨識暫代顯示文字。" : "錄音時會改用 Apple 語音辨識暫代。") : "這個瀏覽器沒有內建語音辨識可以暫代。"));
  if (SRok && !S.webasr && !web.auto) { web.auto = true; if (rec.on) { web.on = true; webStart(); } }
}
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const web = {r:null, on:false, state:"off", stateAt:0, finals:[], up:[], curUp:null, restarts:[], interim:"", lastFinal:"", lastHeard:0, fatal:"", zeroSince:0};
const wnow = () => (performance.now() - rec.t0) / 1000;
function webSet(st){ web.state = st; web.stateAt = performance.now(); liveUI(); }
const WEB_ERR = {"not-allowed":"沒有取得語音辨識權限（請在跳出的視窗允許，或按下方按鈕再試一次）","service-not-allowed":"系統不允許使用語音辨識（請到 iPhone 設定開啟 Siri 與聽寫）","audio-capture":"語音辨識拿不到麥克風（可能和錄音衝突）","language-not-supported":"語音辨識不支援台灣中文","network":"語音辨識需要網路連線"};
function webStart(){
  if (!(S.webasr || web.auto) || !rec.on) return;
  if (!SR) { banner("web", "這個瀏覽器不支援語音辨識（Brave 預設關閉），請改用 Safari 或 Chrome。錄音照常進行。"); return; }
  if (web.r) return;
  const r = new SR();
  r.lang = "zh-TW"; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
  r.onstart = () => { web.seen = []; web.done = []; web.interimItems = []; web.curUp = [wnow(), null]; web.up.push(web.curUp); web.lastHeard = wnow(); webSet("on"); banner("web"); };
  r.onresult = e => {
    let interim = ""; const items = [];
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i], t = (res[0]?.transcript || "").trim();
      if (web.seen[i] == null) web.seen[i] = wnow();          // 這句第一次被聽到的時間，用來對應分段
      if (res.isFinal) { if (t && !web.done[i]) { web.done[i] = true; web.finals.push({t:web.seen[i], text:t}); web.lastFinal = t; } }
      else if (t) { interim += t; items.push({t:web.seen[i], text:t}); }
    }
    web.interim = interim; web.interimItems = items; web.lastHeard = wnow(); liveUI();
  };
  r.onerror = e => { if (WEB_ERR[e.error]) web.fatal = e.error; };
  r.onend = () => {
    (web.interimItems || []).forEach(x => web.finals.push(x)); web.interimItems = []; web.interim = "";
    if (web.curUp) { web.curUp[1] = wnow(); web.curUp = null; }
    web.r = null;
    if (!web.on || !rec.on) { webSet("off"); return; }
    if (web.fatal) return webStop(WEB_ERR[web.fatal] || "語音辨識停止了");
    const t = performance.now(); web.restarts = web.restarts.filter(x => t - x < 30000); web.restarts.push(t);
    if (web.restarts.length > 6) return webStop("Apple 語音辨識在 30 秒內中斷太多次");
    webSet("restart");
    setTimeout(() => { if (web.on && rec.on) webStart(); }, 250);
  };
  web.on = true; web.fatal = "";
  try { r.start(); web.r = r; if (web.state === "off" || web.state === "stopped") webSet("starting"); }
  catch(e) { web.r = null; webStop("無法啟動語音辨識：" + e.message); }
}
function webStop(msg){
  web.on = false;
  try { web.r?.abort(); } catch {}
  web.r = null; if (web.curUp) { web.curUp[1] = wnow(); web.curUp = null; }
  webSet(msg ? "stopped" : "off");
  if (msg) banner("web", "⚠ Apple 語音辨識已停止：" + msg + "。錄音和 Groq 轉錄不受影響。");
}
function webRestart(){ web.restarts = []; web.fatal = ""; banner("web"); if (!rec.on) return toast("開始錄音後才會啟動語音辨識"); web.on = true; webStart(); }
// 每秒由 tick 呼叫：停止提示、卡住偵測、麥克風衝突偵測
function webWatch(rms){
  if (!(S.webasr || web.auto) || !rec.on) return;
  const t = wnow();
  if (web.on && web.state !== "on" && (performance.now() - web.stateAt) > 4000) webStop("重新啟動沒有成功");
  if (web.on && web.state === "on" && (rec.lastVoice - rec.t0) / 1000 > t - 3 && t - web.lastHeard > 25) { web.lastHeard = t; try { web.r?.stop(); } catch {} }
  if (web.on && rms < 1e-6) { if (!web.zeroSince) web.zeroSince = t; else if (t - web.zeroSince > 4) { webStop("iPhone 無法同時錄音和語音辨識（錄音變成無聲），已關閉語音辨識以保護錄音"); S.webasr = false; LS.set("settings", S); $("#webasr").checked = false; } }
  else web.zeroSince = 0;
}
function liveUI(){
  const box = $("#live"); if (!box) return;
  box.hidden = !((S.webasr || web.auto) && rec.on);
  if (box.hidden) return;
  const lab = {on:"Apple 辨識中", starting:"Apple 辨識啟動中…", restart:"Apple 辨識重新連線中…", stopped:"Apple 辨識已停止", off:"Apple 辨識未啟動"}[web.state] || "";
  $("#liveDot").className = "dot " + (web.state === "on" ? "ok" : web.state === "stopped" || web.state === "off" ? "bad" : "mid");
  $("#liveLab").textContent = lab;
  $("#liveTxt").textContent = (web.lastFinal ? "…" + web.lastFinal.slice(-24) : "") + (web.interim ? " " + web.interim : "");
}
function assignWeb(g, tries = 0){
  const a = g.offset, b = g.offset + (+g.dur || 0);
  const inWin = f => f.t > a - 0.3 && f.t <= b + 0.3;
  // Apple 的句子常在說完一陣子後才定稿：還有屬於這段的未定稿句子就再等等（最多約 12 秒）
  if (tries < 5 && (web.interimItems || []).some(inWin)) { setTimeout(() => assignWeb(g, tries + 1), 2000); return; }
  let cover = 0;
  for (const u of web.up) { const e = u[1] ?? wnow(); cover += Math.max(0, Math.min(b, e) - Math.max(a, u[0])); }
  const fs = web.finals.filter(f => !f.used && inWin(f)), its = (web.interimItems || []).filter(inWin);
  fs.forEach(f => f.used = true);
  const text = [...fs, ...its].map(f => f.text).join("");
  if (text) g.web = text;
  else if (b > a && cover / (b - a) >= 0.9 && (g.voiced || 0) >= 1.5) g.web = "";   // 一直在聽、你也有說話，Apple 卻沒聽到
  else g.web = null;   // 辨識沒全程運作或聲音太少，不拿來判斷
  g.webV = 2;
  g.webPending = false;
  if (g.alts.length) applyBest(g);
  computeRisk(g); touch(g); saveSeg(g, true); render(); if (rvId === g.id) fillReview(false); pump();
}
$("#webasr").addEventListener("change", e => { if (e.target.checked && !SR) toast("這個瀏覽器不支援語音辨識，請改用 Safari 或 Chrome"); if (rec.on) { if (e.target.checked) { S.webasr = true; webRestart(); } else webStop(); } liveUI(); });

