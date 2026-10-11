"use strict";
/* ================= IndexedDB ================= */
let db;
function openDB(){ return new Promise((res,rej)=>{ const r=indexedDB.open("groq-dictation",3);
  r.onupgradeneeded=()=>{ const d=r.result;
    if(!d.objectStoreNames.contains("sessions")) d.createObjectStore("sessions",{keyPath:"id"});
    if(!d.objectStoreNames.contains("segs")) d.createObjectStore("segs",{keyPath:"id"}).createIndex("sid","sid");
    if(!d.objectStoreNames.contains("sources")) d.createObjectStore("sources",{keyPath:"id"}).createIndex("sid","sid");
    if(!d.objectStoreNames.contains("master")) d.createObjectStore("master",{keyPath:"id"}).createIndex("sid","sid"); };
  r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); r.onblocked=()=>toast("請關閉其他開著本工具的分頁後重新整理"); }); }
function req(store, mode, fn){ return new Promise((res,rej)=>{ const t=db.transaction(store,mode); const q=fn(t.objectStore(store));
  t.oncomplete=()=>res(q ? q.result : undefined); t.onerror=()=>rej(t.error); t.onabort=()=>rej(t.error || new Error("儲存被中止")); }); }
/* 音檔以 ArrayBuffer 存進 IndexedDB：Safari 存 Blob 在重新整理後常讀不出來（NotFoundError） */
const AUDIO_STORES = ["segs","sources","master"];
async function put(s, v){
  if (!AUDIO_STORES.includes(s) || !v) return req(s,"readwrite",o=>o.put(v));
  const {_ab, _abFrom, blob, ...r} = v;
  if (blob instanceof Blob) {
    if (!v._ab || v._abFrom !== blob) {
      try { v._ab = await blob.arrayBuffer(); v._abFrom = blob; }
      catch { v.blob = null; v._ab = null; v._abFrom = null; v.audioLost = true; r.audioLost = true; r.blob = null; return req(s,"readwrite",o=>o.put(r)); }
    }
    r.blob = null; r.ab = v._ab; r.abType = blob.type || "";
  } else r.blob = null;
  return req(s,"readwrite",o=>o.put(r));
}
function hydrate(r){
  if (r && r.ab) { r.blob = new Blob([r.ab], {type:r.abType || ""}); r._ab = r.ab; r._abFrom = r.blob; delete r.ab; delete r.abType; }
  return r;
}
const getAll = async s => { const a = await req(s,"readonly",o=>o.getAll()); return AUDIO_STORES.includes(s) ? a.map(hydrate) : a; };
const getOne = async (s,k) => { const r = await req(s,"readonly",o=>o.get(k)); return AUDIO_STORES.includes(s) ? hydrate(r) : r; };
const bySid = async (s,sid) => { const a = await req(s,"readonly",o=>o.index("sid").getAll(sid)); return AUDIO_STORES.includes(s) ? a.map(hydrate) : a; };
const delKey = (s,k) => req(s,"readwrite",o=>o.delete(k));

/* ================= 狀態 ================= */
let sessions=[], cur=null, filter="all", paused=false, pausedReason="";
const segs = new Map();
const saveTimers = {};
function normalize(g){
  return Object.assign({blob:null, ext:"webm", srcId:null, start:null, end:null, dur:0, voiced:null, raw:"", text:"", model:"", lp:null,
    asrRisk:0, risk:0, flags:[], dropped:[], lowParts:[], alts:[], issues:[], history:[], edited:false, reviewed:false, userSkip:false,
    orgNote:"", tries:0, nextAt:0, err:"", forceModel:null, prefer:null, solo:false, agree:null, _v:0}, g);
}
const touch = g => { g._v = (g._v||0) + 1; };
function saveSeg(g, now){
  clearTimeout(saveTimers[g.id]);
  const go = () => put("segs", g).then(()=>{ banner("quota"); driveDirty(g.sid); }).catch(e => {
    if (e && e.name === "QuotaExceededError") banner("quota", "儲存空間已滿：請匯出 ZIP 後刪除舊的工作階段或音檔。");
    else console.error(e);
  });
  if (now) return go();
  saveTimers[g.id] = setTimeout(go, 400);
}
const sorted = () => [...segs.values()].sort((a,b)=>a.seq-b.seq);
const segBySeq = seq => { for (const g of segs.values()) if (g.seq===seq) return g; return null; };
const openIssues = g => (g.issues||[]).filter(i => !i.state);
const ISS_W = {"疑似幻聽":2, "語意不通":1, "疑似錯字":1, "數字或名詞存疑":1};
function computeRisk(g){ g.risk = (g.asrRisk||0) + openIssues(g).reduce((s,i)=>s+(ISS_W[i.type]||1),0); }
function needsReview(g){
  if (g.reviewed) return false;
  if (g.status==="err_tx" || g.status==="err_fx") return true;
  if (g.status!=="done") return false;
  return g.risk>=2 || openIssues(g).length>0 || !!g.orgNote;
}
const hasAudio = g => !!(g.blob || g.srcId || g.driveAudioId);

/* ================= 工作階段 ================= */
async function loadSessions(){
  sessions = (await getAll("sessions")).sort((a,b)=>b.created-a.created);
  if (!sessions.length) await newSession();
  const want = LS.get("cur", null);
  await switchSession(sessions.find(s=>s.id===want) ? want : sessions[0].id);
}
async function newSession(){
  const d = new Date();
  const s = {id:"s"+Date.now(), name:d.toLocaleDateString("zh-TW")+" "+d.toLocaleTimeString("zh-TW",{hour12:false,hour:"2-digit",minute:"2-digit"}), created:Date.now(), organized:"", orgItems:[]};
  await put("sessions", s); sessions.unshift(s); return s;
}
async function switchSession(id){
  if (rec.on) { toast("錄音中無法切換工作階段"); renderSessSel(); return; }
  closeReview();
  cur = sessions.find(s=>s.id===id); LS.set("cur", id);
  segs.clear();
  for (const raw of await bySid("segs", id)) {
    const g = normalize(raw);
    if (g.status==="transcribing") g.status="queued";
    if (g.status==="fixing") g.status="transcribed";
    g.nextAt = 0; g.webPending = false;
    if (g.webV !== 2 && g.flags.includes("Apple 沒聽到內容")) { g.flags = g.flags.filter(f => f !== "Apple 沒聽到內容"); g.asrRisk = Math.max(0, (g.asrRisk||0) - 2); g.web = null; g.webV = 2; }
    if (!g.alts.length && g.raw && HALLU.test(g.raw) && !g.flags.includes("提示詞外洩")) { g.flags = [...g.flags, "提示詞外洩"]; g.asrRisk = Math.max(g.asrRisk||0, 3); g.reviewed = false; }
    computeRisk(g); segs.set(g.id, g);
  }
  renderSessSel(); $("#segList").innerHTML=""; render(); drawOrg(); pump(); renderTakes();
  migrateAudio(id);
}
async function migrateAudio(sid){
  let lost = 0, fixed = 0;
  for (const g of sorted()) {
    if (cur?.id !== sid) return;
    if (g.blob && !g._ab) { await put("segs", g); if (g.audioLost) { lost++; touch(g); computeRisk(g); } else fixed++; }
  }
  for (const src of await bySid("sources", sid)) if (src.blob && !src._ab) await put("sources", src);
  if (lost) { render(); banner("lost", `有 ${lost} 段舊錄音的音檔在這個瀏覽器裡已經讀不出來（Safari 的儲存問題），文字仍保留。新錄的音檔已改用穩定的方式保存。`); }
}
function renderSessSel(){ $("#sessSel").innerHTML = sessions.map(s=>`<option value="${esc(s.id)}" ${cur&&s.id===cur.id?"selected":""}>${esc(s.name)}</option>`).join(""); }
$("#sessSel").onchange = e => switchSession(e.target.value);
$("#newSess").onclick = async () => { if (rec.on) return toast("請先停止錄音"); const s = await newSession(); await switchSession(s.id); };
$("#renSess").onclick = () => {
  const sel=$("#sessSel"); const inp=document.createElement("input"); inp.type="text"; inp.id="renInput"; inp.value=cur.name;
  sel.replaceWith(inp); inp.focus(); inp.select(); let done=false;
  const finish = async save => { if(done) return; done=true; if(save){ cur.name = inp.value.trim()||cur.name; await put("sessions",cur); driveDirty(cur.id); } inp.replaceWith(sel); renderSessSel(); };
  inp.onkeydown = e => { if(e.key==="Enter") finish(true); if(e.key==="Escape") finish(false); };
  inp.onblur = () => finish(true);
};
function delHandler(){
  if (rec.on) return toast("請先停止錄音");
  $("#delWrap").innerHTML = `<span class="confirm">刪除「${esc(cur.name)}」和所有音檔？<button class="danger" id="yesDel" type="button">確定刪除</button><button id="noDel" type="button">取消</button></span>`;
  $("#noDel").onclick = resetDel;
  $("#yesDel").onclick = async () => {
    for (const g of await bySid("segs",cur.id)) await delKey("segs", g.id);
    for (const s of await bySid("sources",cur.id)) await delKey("sources", s.id);
    for (const c of await bySid("master",cur.id)) await delKey("master", c.id);
    await delKey("sessions", cur.id);
    sessions = sessions.filter(s=>s.id!==cur.id); if (!sessions.length) await newSession();
    resetDel(); await switchSession(sessions[0].id); storageInfo();
  };
}
function resetDel(){ $("#delWrap").innerHTML = '<button id="delSess" class="danger" type="button">刪除</button>'; $("#delSess").onclick = delHandler; }
$("#delSess").onclick = delHandler;

/* ================= 新增段落 ================= */
function nextSeq(){ let m=0; segs.forEach(g=>{ if(g.seq>m) m=g.seq; }); return m+1; }
async function addSegment(blob, meta){
  meta = meta || {};
  const seq = nextSeq();
  const g = normalize({id:cur.id+":"+String(seq).padStart(5,"0"), sid:cur.id, seq, at:meta.at||Date.now(), dur:meta.dur||0, offset:meta.offset??null,
    blob:blob||null, ext:meta.ext||"webm", srcId:meta.srcId||null, start:meta.start??null, end:meta.end??null, src:meta.src||"mic",
    voiced:meta.voiced??null, status:"queued", gap:meta.gap||0, gapWhy:meta.gapWhy||""});
  if (meta.skip) { g.status="skip"; g.text=meta.skip; }
  if (meta.web && g.status !== "skip") { g.webPending = true; setTimeout(() => assignWeb(g), 2600); }
  segs.set(g.id, g); await saveSeg(g, true); render(); pump();
}

