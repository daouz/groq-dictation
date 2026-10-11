"use strict";
/* ================= 錄音與自動切段 ================= */
const rec = {on:false, stream:null, ctx:null, an:null, buf:null, mr:null, segStart:0, lastVoice:0, voiced:0, t0:0, iv:null, mime:"", ext:"webm", wake:null, lastTick:0};
const IS_WEBKIT = /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Android/.test(navigator.userAgent)) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function pickMime(){
  // iPhone／Safari 錄成 WebM 時自己常常播不出來，改錄 MP4（AAC），Groq 也接受
  const order = IS_WEBKIT ? [["audio/mp4","m4a"],["audio/webm;codecs=opus","webm"],["audio/webm","webm"]] : [["audio/webm;codecs=opus","webm"],["audio/webm","webm"],["audio/mp4","m4a"]];
  for (const [m,e] of order)
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return [m,e];
  return ["", "webm"];
}
function startRecorder(){
  let mr; const bps = S.kbps*1000;
  try { mr = new MediaRecorder(rec.stream, rec.mime ? {mimeType:rec.mime, audioBitsPerSecond:bps} : {audioBitsPerSecond:bps}); }
  catch { mr = new MediaRecorder(rec.stream); }
  const chunks = []; const meta = {at:Date.now(), offset:(performance.now()-rec.t0)/1000};
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstop = () => {
    const blob = new Blob(chunks, {type: chunks[0]?.type || rec.mime || "audio/webm"});
    if (blob.size < 200) return;
    const v = mr._voiced || 0;
    meta.dur = mr._dur ?? (performance.now() - mr._t0) / 1000; meta.voiced = v; meta.ext = extOf(blob.type) || rec.ext;
    meta.gap = mr._gap || 0; meta.gapWhy = mr._gapWhy || "";
    if (v < 0.25) meta.skip = "（靜音）";      // 很短但有聲音的話照樣送出轉錄，不再略過
    meta.web = (S.webasr || web.auto) && web.on;
    addSegment(blob, meta).catch(e => banner("save", "存檔失敗：" + e.message));
  };
  mr.start(); mr._t0 = performance.now();
  rec.mr = mr; rec.segStart = performance.now(); rec.lastVoice = rec.segStart; rec.voiced = 0; rec.segGap = 0; rec.segGapWhy = "";
}
function cut(){
  if (!rec.mr) return;
  const old = rec.mr, t0 = rec.segStart; old._voiced = rec.voiced; old._gap = rec.segGap; old._gapWhy = rec.segGapWhy;
  const keep = rec.on && !rec.paused;
  if (keep) startRecorder(); else rec.mr = null;   // 先接上新的錄音器
  // 舊的晚 0.5 秒才停：交接處重疊，避免 iPhone 編碼啟動延遲造成缺音
  const stopIt = () => { old._dur = (performance.now() - t0) / 1000; try { old.stop(); } catch {} };
  if (keep) setTimeout(stopIt, 500); else stopIt();
}
async function startRec(){
  if (S.hwkeys) hwArm();   // 必須在使用者按下的當下啟動，iOS 才會把耳機按鍵交給這個頁面
  readForm();
  if (!S.key) { $("#settings").hidden=false; return toast("請先輸入 Groq API key"); }
  try { rec.stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:!!S.agc}}); }
  catch(e){ return toast("無法使用麥克風：" + e.message); }
  try { await navigator.storage?.persist?.(); } catch {}
  [rec.mime, rec.ext] = pickMime();
  const AC = window.AudioContext || window.webkitAudioContext;
  rec.ctx = new AC();
  const src = rec.ctx.createMediaStreamSource(rec.stream); rec.an = rec.ctx.createAnalyser(); rec.an.fftSize = 1024; src.connect(rec.an);
  rec.buf = new Float32Array(rec.an.fftSize);
  const trk = rec.stream.getAudioTracks()[0];
  trk?.addEventListener("mute", () => { rec.muteAt = performance.now(); });
  trk?.addEventListener("unmute", () => { if (rec.muteAt) { noteGap((performance.now() - rec.muteAt) / 1000, "麥克風被系統暫時佔用，例如來電或 Siri"); rec.muteAt = 0; } });
  rec.stream.getAudioTracks()[0]?.addEventListener("ended", () => { if (rec.on) { stopRec(); banner("mic", "麥克風中斷（可能是裝置拔除或系統打斷），已停止錄音並保存目前內容。"); } });
  rec.on = true; rec.t0 = performance.now(); rec.lastTick = rec.t0; rec.gapCount = 0; banner("gap"); startRecorder(); masterStart();
  rec.iv = setInterval(tick, 50);
  web.finals = []; web.up = []; web.restarts = []; web.lastFinal = ""; web.interim = ""; web.zeroSince = 0;
  if (S.webasr || web.auto) webStart();
  liveUI();
  try { rec.wake = await navigator.wakeLock?.request("screen"); } catch {}
  banner("mic");
  rec.paused = false;
  $("#recBtn").classList.add("on"); $("#recBtn").setAttribute("aria-label","停止錄音"); recStateUI(); $("#cutBtn").disabled=false; $("#pauseRecBtn").disabled=false;
  if (S.hwkeys) hwOn();
}
function stopRec(){
  hwOff(); rec.paused = false; $("#pauseRecBtn").disabled = true;
  if (web.on || web.r) webStop(); banner("web");
  rec.on = false; clearInterval(rec.iv); cut(); masterStop(); liveUI();
  setTimeout(() => { try { if (navigator.audioSession) navigator.audioSession.type = "auto"; } catch {} }, 300);
  rec.stream?.getTracks().forEach(t=>t.stop()); rec.ctx?.close().catch(()=>{});
  try { rec.wake?.release(); } catch {}
  $("#recBtn").classList.remove("on"); $("#recBtn").setAttribute("aria-label","開始錄音"); $("#recState").textContent="已停止・按紅色按鈕繼續錄音"; $("#recState").classList.remove("on");
  $("#cutBtn").disabled=true; $("#lvl").style.width="0"; $("#segp").style.width="0";
}
function noteGap(sec, why){
  if (!rec.on || rec.paused || sec < 1) return;
  rec.segGap = (rec.segGap || 0) + sec; rec.segGapWhy = why;
  rec.gapCount = (rec.gapCount || 0) + 1;
  banner("gap", `⚠ 錄音可能中斷了約 ${Math.round(sec)} 秒（${why}）。已在該段標示，請保持本頁在前景、螢幕不要鎖定。`);
}
function tick(){
  rec.an.getFloatTimeDomainData(rec.buf);
  let sum=0; for (let i=0;i<rec.buf.length;i++) sum += rec.buf[i]*rec.buf[i];
  const rms = Math.sqrt(sum/rec.buf.length), now = performance.now(), dt = now - rec.lastTick; rec.lastTick = now;
  if (dt > 1500) noteGap(dt / 1000, document.visibilityState === "hidden" ? "網頁切到背景或螢幕鎖定" : "系統暫停了網頁");
  $("#lvl").style.width = Math.min(100, Math.sqrt(rms/0.25)*100) + "%";
  if (rec.paused) return;
  if (rms > S.thr) { rec.lastVoice = now; rec.voiced += dt/1000; }
  if (now - (rec.lastWatch||0) > 1000) { rec.lastWatch = now; webWatch(rms); }
  const el = (now-rec.segStart)/1000;
  $("#timer").textContent = fmtT((now-rec.t0)/1000);
  $("#segp").style.width = Math.min(100, el/S.maxSec*100) + "%";
  if (el >= S.maxSec) {
    if (rec.voiced < 0.2) return cut();                          // 幾乎無聲：照常切
    if (rec.voiced < 0.6 && el < S.maxSec * 2) return;           // 只有一兩個字：併入下一段，不單獨成段
    if (now - rec.lastVoice >= 300 || el >= S.maxSec + 15) return cut();   // 等到短暫停頓再切，避免切在字中間
    return;
  }
  if (S.mode==="auto" && el >= S.minSec && rec.voiced >= 0.6 && now - rec.lastVoice >= 700) return cut();
}
$("#recBtn").onclick = () => rec.on ? stopRec() : startRec();
$("#cutBtn").onclick = () => cut();
$("#pauseRecBtn").onclick = () => rec.paused ? resumeRec() : pauseRec();

/* ---------- 暫停／繼續錄音（麥克風保持開啟，所以耳機按鍵也能恢復） ---------- */
function recStateUI(){
  const st = $("#recState"), pb = $("#pauseRecBtn");
  if (!rec.on) return;
  st.textContent = rec.paused ? "已暫停・按 ▶ 或耳機按一下繼續" : "錄音中・停頓時自動切段" + (S.hwkeys && hw.armed ? "・耳機可控制" : "");
  st.classList.toggle("on", !rec.paused);
  $("#recBtn").classList.toggle("paused", !!rec.paused);
  pb.setAttribute("aria-label", rec.paused ? "繼續錄音" : "暫停錄音");
  pb.innerHTML = rec.paused ? '<svg class="ico" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' : '<svg class="ico" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
}
function pauseRec(){
  if (!rec.on || rec.paused) return;
  rec.paused = true; cut(); try { if (master.mr?.state === "recording") master.mr.pause(); } catch {} beep("pause"); recStateUI(); hwState();
  toast("錄音已暫停");
}
function resumeRec(){
  if (!rec.on || !rec.paused) return;
  rec.paused = false; startRecorder(); try { if (master.mr?.state === "paused") master.mr.resume(); } catch {} beep("resume"); recStateUI(); hwState();
  toast("繼續錄音");
}
function beep(kind){
  try {
    const ac = rec.ctx; if (!ac) return; if (ac.state === "suspended") ac.resume();
    const tones = kind === "pause" ? [660, 440] : kind === "resume" ? [440, 660] : [880];
    tones.forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + i * 0.13;
      o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.12);
    });
  } catch {}
}

/* ---------- 耳機／AirPods 按鍵（Media Session） ---------- */
const hw = {audio:null, url:"", armed:false, lastCut:0};
function hwArm(){
  if (!("mediaSession" in navigator)) return;
  try {
    if (!hw.audio) { hw.url = URL.createObjectURL(wav16(new Float32Array(16000))); hw.audio = new Audio(hw.url); hw.audio.loop = true; hw.audio.volume = 0.01; }
    hw.audio.play().then(() => { hw.armed = true; recStateUI(); }).catch(() => {});
  } catch {}
}
function hwOn(){
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  try { ms.metadata = new MediaMetadata({title:"連續聽寫・錄音中", artist:cur?.name || "", album:"Groq 連續聽寫"}); } catch {}
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
  set("play", () => { resumeRec(); hw.audio?.play().catch(()=>{}); });
  set("pause", () => { pauseRec(); });
  set("stop", null);
  set("nexttrack", () => { if (!rec.on || rec.paused) return; const t = Date.now(); if (t - hw.lastCut < 800) return; hw.lastCut = t; cut(); beep("cut"); toast("已切段"); });
  set("previoustrack", null);
  set("togglemicrophone", () => { rec.paused ? resumeRec() : pauseRec(); });
  hwState();
}
function hwState(){ try { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = rec.paused ? "paused" : "playing"; } catch {} }
function hwOff(){
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  ["play","pause","nexttrack","togglemicrophone"].forEach(a => { try { ms.setActionHandler(a, null); } catch {} });
  try { ms.metadata = null; ms.playbackState = "none"; } catch {}
  try { hw.audio?.pause(); } catch {}
  hw.armed = false;
}
document.addEventListener("visibilitychange", async () => {
  if (rec.on && document.visibilityState==="visible") { try { rec.wake = await navigator.wakeLock?.request("screen"); } catch {} }
});

/* ================= 完整母帶（不切段、每 5 秒寫入一次） ================= */
const master = {mr:null, take:null, idx:0, sid:null, t0:0};
function masterStart(){
  if (!S.master || !rec.stream) return;
  let mr; const bps = S.kbps * 1000;
  try { mr = new MediaRecorder(rec.stream, rec.mime ? {mimeType:rec.mime, audioBitsPerSecond:bps} : {audioBitsPerSecond:bps}); }
  catch { try { mr = new MediaRecorder(rec.stream); } catch { return; } }
  const take = {id:"tk" + Date.now().toString(36), at:Date.now(), ext:rec.ext, mime:mr.mimeType || rec.mime || "audio/webm", bytes:0, dur:0, ended:0, driveId:null};
  cur.takes = (cur.takes || []).concat(take); put("sessions", cur).catch(() => {});
  Object.assign(master, {mr, take, idx:0, sid:cur.id, t0:performance.now()});
  const sid = cur.id;
  mr.ondataavailable = e => {
    if (!e.data || !e.data.size) return;
    const i = master.mr === mr ? master.idx++ : (take._i = (take._i || 1000) + 1);
    take.bytes += e.data.size;
    put("master", {id:take.id + ":" + String(i).padStart(6, "0"), sid, take:take.id, i, blob:e.data}).catch(err => banner("save", "完整錄音存檔失敗：" + err.message));
  };
  mr.onstop = () => {
    take.ended = Date.now(); take.dur = Math.round((take.ended - take.at) / 1000);
    const s = sessions.find(x => x.id === sid); if (s) { const t = (s.takes || []).find(x => x.id === take.id); if (t) Object.assign(t, take); setTimeout(() => put("sessions", s).then(() => { driveDirty(sid); renderTakes(); }), 800); }
  };
  try { mr.start(5000); } catch { master.mr = null; }
}
function masterStop(){ const mr = master.mr; master.mr = null; try { if (mr && mr.state !== "inactive") mr.stop(); } catch {} }
async function takeBlob(sid, take){
  const parts = (await bySid("master", sid)).filter(c => c.take === take.id).sort((a,b) => a.i - b.i);
  return new Blob(parts.map(c => c.blob), {type:take.mime || "audio/webm"});
}
async function renderTakes(){
  const box = $("#takeList"); if (!box || !cur) return;
  const ts = (cur.takes || []).filter(t => t.bytes > 0);
  box.innerHTML = ts.length ? `<div class="note" style="margin-bottom:4px">完整錄音（不切段）</div>` + ts.map(t => `<div class="hist"><span class="t" style="color:var(--fg)">${new Date(t.at).toLocaleString("zh-TW",{hour12:false,month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}　${t.ended ? fmtT(t.dur) : "錄音中…"}　${MB(t.bytes)}${t.driveId ? "　已備份到 Drive" : ""}</span>${t.ended ? `<button type="button" data-take="${esc(t.id)}">下載</button>` : ""}</div>`).join("") : "";
}
$("#takeList").addEventListener("click", async e => {
  const b = e.target.closest("button[data-take]"); if (!b) return;
  const t = (cur.takes || []).find(x => x.id === b.dataset.take); if (!t) return;
  b.disabled = true;
  try { const blob = await takeBlob(cur.id, t); download(`${fname("x").slice(0,-2)}_完整錄音_${new Date(t.at).toTimeString().slice(0,5).replace(":","")}.${t.ext || "webm"}`, blob); }
  catch(err) { toast("下載失敗：" + err.message); } finally { b.disabled = false; }
});

