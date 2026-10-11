"use strict";
/* ================= 基本工具 ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtT = s => { s = Math.max(0, Math.floor(s)); return [s/3600|0, (s%3600)/60|0, s%60].map(v => String(v).padStart(2,"0")).join(":"); };
const clock = ts => new Date(ts).toLocaleTimeString("zh-TW", {hour12:false});
const MB = n => (n/1048576).toFixed(1) + " MB";
const fmtWait = ms => ms >= 3600000 ? Math.ceil(ms/3600000)+" 小時" : ms >= 60000 ? Math.ceil(ms/60000)+" 分鐘" : Math.ceil(ms/1000)+" 秒";
function toast(m){ const t=$("#toast"); t.textContent=m; t.classList.add("on"); clearTimeout(toast.h); toast.h=setTimeout(()=>t.classList.remove("on"),2600); }
const LS = { get(k,d){ try{ const v=localStorage.getItem("gd_"+k); return v==null?d:JSON.parse(v); }catch{ return d; } }, set(k,v){ try{ localStorage.setItem("gd_"+k, JSON.stringify(v)); }catch{} } };
const V3 = "whisper-large-v3", TURBO = "whisper-large-v3-turbo";
const MNAME = m => m===V3 ? "large-v3" : m===TURBO ? "turbo" : String(m||"");
const GROQ_OK = ["mp3","mp4","mpeg","mpga","m4a","wav","webm"];
const extOf = type => { type = String(type||""); return /mp4|m4a|aac/.test(type) ? "m4a" : /ogg/.test(type) ? "ogg" : /wav/.test(type) ? "wav" : /mpeg|mp3/.test(type) ? "mp3" : /webm/.test(type) ? "webm" : ""; };
const mimeOf = name => ({webm:"audio/webm",m4a:"audio/mp4",mp4:"audio/mp4",ogg:"audio/ogg",wav:"audio/wav",mp3:"audio/mpeg",flac:"audio/flac"})[String(name).split(".").pop().toLowerCase()] || "application/octet-stream";

/* ================= 設定 ================= */
const DEF = {key:"", asr:TURBO, escalate:"v3", lang:"zh", tier:"free", fixModel:"openai/gpt-oss-120b", orgModel:"openai/gpt-oss-120b",
  mode:"auto", minSec:8, maxSec:40, thr:0.015, kbps:24, agc:false, autoplay:true, vocab:"", driveAuto:true, webasr:false, hwkeys:true, master:true};
const S = Object.assign({}, DEF, LS.get("settings", {}));
if (typeof S.escalate === "boolean") S.escalate = S.escalate ? "v3" : "off";
const NUM = ["minSec","maxSec","thr","kbps"];
const FIELDS = Object.keys(DEF);
// 免費方案：gpt-oss 每分鐘 8K token、每天 200K；Whisper 每分鐘 20 次。每次請求都控制在上限內。
const TIER = () => S.tier === "dev"
  ? {tx:4, fx:3, batch:2500, fixTok:4000, org:9000, orgTok:9000, orgEffort:"medium"}
  : {tx:2, fx:1, batch:900,  fixTok:2500, org:1800, orgTok:3200, orgEffort:"low"};
function loadForm(){ for (const f of FIELDS){ const el=$("#"+f); if(!el) continue; if(el.type==="checkbox") el.checked=!!S[f]; else el.value=S[f]; } markThr(); }
function readForm(){
  for (const f of FIELDS){ const el=$("#"+f); if(!el) continue; S[f] = el.type==="checkbox" ? el.checked : NUM.includes(f) ? Number(el.value) : el.value.trim(); }
  S.minSec = Math.min(60, Math.max(3, S.minSec||8)); S.maxSec = Math.min(120, Math.max(S.minSec+2, S.maxSec||40));
  LS.set("settings", S);
}
function markThr(){ $("#thrMark").style.left = Math.min(100, Math.sqrt(Number($("#thr").value)/0.25)*100) + "%"; }
$("#thr").addEventListener("input", markThr);
$("#settings").addEventListener("change", () => { readForm(); $("#setMsg").textContent = "已自動儲存"; renderStats(); pump(); });
$("#setClose").onclick = () => { $("#settings").hidden = true; };
$("#moreMenu").addEventListener("click", e => { const b = e.target.closest("button"); if (b && b.id !== "delSess" && !b.closest(".confirm")) $("#moreMenu").open = false; });
document.addEventListener("click", e => { const m = $("#moreMenu"); if (m.open && !m.contains(e.target)) m.open = false; });
$("#setBtn").addEventListener("click", () => renderTakes());
$("#setBtn").onclick = () => { $("#settings").hidden = !$("#settings").hidden; if(!$("#settings").hidden) storageInfo(); };
$("#testKey").onclick = async () => {
  readForm(); $("#setMsg").textContent = "測試中…";
  try { const r = await fetch("https://api.groq.com/openai/v1/models", {headers:{Authorization:"Bearer "+S.key}});
    $("#setMsg").textContent = r.ok ? "金鑰可用" : "金鑰無效（HTTP "+r.status+"）";
    if (r.ok && paused && pausedReason==="key") setPaused(false);
  } catch(e){ $("#setMsg").textContent = "連線失敗：" + e.message; }
};
const vocabList = () => S.vocab.split(/[,，、\n]/).map(s=>s.trim()).filter(Boolean);
loadForm();
if (!S.key) $("#settings").hidden = false;

/* ================= 提示橫幅 ================= */
const banners = {};
function banner(kind, msg){ if ((banners[kind]||"") === (msg||"")) return; if (msg) banners[kind]=msg; else delete banners[kind]; drawBanner(); }
function drawBanner(){
  const b=$("#banner"); const ks=Object.keys(banners);
  b.hidden = !ks.length;
  b.innerHTML = ks.map(k => `<span>${esc(banners[k])}${["backup","lost","web","save"].includes(k) ? `<button type="button" class="x" data-bk="${k}" aria-label="關閉提示">×</button>` : ""}</span>`).join("") + (paused ? '<button type="button" id="resumeBtn">繼續處理</button>' : "") + (banners.drv ? '<button type="button" id="drvRe">連線 Google Drive</button>' : "");
  const rb=$("#resumeBtn"); if(rb) rb.onclick = () => setPaused(false);
  b.querySelectorAll("button[data-bk]").forEach(x => x.onclick = () => { if (x.dataset.bk === "backup" && cur) LS.set("lastExport_"+cur.id, Date.now()); banner(x.dataset.bk); });
  const dr=$("#drvRe"); if(dr) dr.onclick = () => driveConnect();
  if (banners.web && rec.on && (S.webasr || web.auto)) { const w = document.createElement("button"); w.type = "button"; w.textContent = "重新啟動語音辨識"; w.onclick = () => webRestart(); b.append(w); }
}

