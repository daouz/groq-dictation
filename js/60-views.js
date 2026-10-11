"use strict";
/* ================= 文字工具 ================= */
const TYPECLS = {"疑似幻聽":"hl-h", "語意不通":"hl-s", "疑似錯字":"hl-t", "數字或名詞存疑":"hl-t", "疑似接縫重複":"hl-s"};
function pushHist(g, text){ if (!text) return; if (g.history[0]?.text === text) return; g.history.unshift({t:Date.now(), text}); g.history = g.history.slice(0, 20); }
function recheckIssues(g){ const t = g.text || ""; for (const i of g.issues) if (!i.state && i.quote && !t.includes(i.quote)) i.state = "fixed"; computeRisk(g); }
function hlText(g){
  const t = g.text || g.raw || ""; const ranges = [];
  for (const i of g.issues || []) { if (i.state || !i.quote) continue; const p = t.indexOf(i.quote); if (p >= 0) ranges.push({a:p, b:p+i.quote.length, cls:TYPECLS[i.type]||"hl-s", tip:i.type+(i.note?"："+i.note:"")}); }
  ranges.sort((x,y)=>x.a-y.a);
  let out = "", pos = 0;
  for (const r of ranges) { if (r.a < pos) continue; out += esc(t.slice(pos, r.a)) + `<mark class="${r.cls}" title="${esc(r.tip)}">` + esc(t.slice(r.a, r.b)) + "</mark>"; pos = r.b; }
  return out + esc(t.slice(pos));
}
function confChip(g){
  if (g.lp == null) return "";
  const [lab, cls] = g.lp >= -0.45 ? ["高","d"] : g.lp >= -0.8 ? ["中",""] : ["低","e"];
  return `<span class="chip ${cls}" title="平均 log 機率 ${g.lp.toFixed(2)}">信心${lab}</span>`;
}
const flagChip = f => `<span class="chip ${/一致/.test(f)?"d":"w"}">${esc(f)}</span>`;

/* ================= 畫面：統計、篩選、列表 ================= */
const STAT = {queued:["等待轉錄","q"], transcribing:["轉錄中","t"], transcribed:["等待修正","q"], fixing:["修正中","t"], done:["完成","d"], skip:["已略過","q"], err_tx:["轉錄失敗","e"], err_fx:["修正失敗","e"]};
const FILTERS = {
  all:{name:"全部", fn:g=>true},
  review:{name:"待審閱", fn:needsReview},
  err:{name:"失敗", fn:g=>g.status==="err_tx"||g.status==="err_fx"},
  edited:{name:"已手改", fn:g=>g.edited},
  ok:{name:"已確認", fn:g=>g.reviewed},
  skip:{name:"已略過", fn:g=>g.status==="skip"}
};
let rq = 0;
function render(){ if (rq) return; rq = requestAnimationFrame(() => { rq = 0; drawSegViews(); drawFilters(); renderStats(); drawMerged(); }); }
function renderStats(){
  const c = {}; let bytes = 0; segs.forEach(g => { c[g.status] = (c[g.status]||0) + 1; if (g.blob) bytes += g.blob.size || 0; });
  const wait = (c.queued||0) + (c.transcribed||0), busyN = (c.transcribing||0) + (c.fixing||0), rv = sorted().filter(needsReview).length;
  $("#stats").innerHTML = [
    `<span class="chip">共 ${segs.size} 段</span>`,
    wait ? `<span class="chip">排隊 ${wait}</span>` : "",
    busyN ? `<span class="chip t">處理中 ${busyN}</span>` : "",
    `<span class="chip d">完成 ${c.done||0}</span>`,
    rv ? `<button type="button" class="chip e" id="statRv">待審閱 ${rv}</button>` : "",
    bytes ? `<span class="chip">音檔 ${MB(bytes)}</span>` : "",
    paused ? `<span class="chip w">已暫停</span>` : "",
    lanes.tx.until > Date.now() && wait ? `<span class="chip w">等待 Groq 額度 ${wait}</span>` : "",
    !S.key ? `<span class="chip e">尚未設定 API key</span>` : "",
    '<span class="chip" id="drvChip" hidden></span>'
  ].join("");
  driveUI();
  const b = $("#statRv"); if (b) b.onclick = () => { setFilter("review"); showTab("segs"); };
}
function setFilter(f){ filter = f; drawFilters(); drawList(); }
function drawFilters(){
  const all = sorted();
  $("#filters").innerHTML = Object.entries(FILTERS).map(([k,f]) => `<button type="button" data-f="${k}" class="${k===filter?"on":""}">${f.name} ${all.filter(f.fn).length}</button>`).join("");
}
$("#filters").addEventListener("click", e => { const b = e.target.closest("button[data-f]"); if (b) setFilter(b.dataset.f); });
function rowHTML(g){
  const [lab, cls] = STAT[g.status] || [g.status, ""];
  const t = g.text || g.raw;
  const body = t ? hlText(g) : g.web ? `<span class="prov">${esc(g.web)}</span>` : `<span class="ph">${g.status==="transcribing"?"轉錄中…":g.status.startsWith("err")?"沒有結果":"等待轉錄…"}</span>`;
  const openN = openIssues(g).length, active = !/done|skip/.test(g.status);
  return `<div class="seg${g.status==="skip"?" skip":""}${needsReview(g)?" need":""}${g.id===rvId?" cur":""}" data-id="${esc(g.id)}">
    <div class="n">${g.seq}<span>${clock(g.at).slice(0,5)}</span><span>${g.dur ? Number(g.dur).toFixed(0)+"s" : ""}</span></div>
    <div class="body">
      <div class="txt" tabindex="0" role="button" aria-label="審閱第 ${g.seq} 段">${body}</div>
      <div class="meta">
        ${g.status !== "done" ? `<span class="chip ${cls}">${lab}${g.tries && active ? " · 重試 "+g.tries : ""}</span>` : ""}
        ${!t && g.web ? `<span class="chip w">暫用 Apple 辨識</span>` : ""}${g.lp != null && g.lp < -0.8 ? confChip(g) : ""}
        ${g.flags.map(flagChip).join("")}
        ${openN ? `<span class="chip e">待確認 ${openN}</span>` : ""}${g.orgNote ? `<span class="chip e">整理時標註</span>` : ""}
        ${g.edited ? `<span class="chip">已手改</span>` : ""}${g.reviewed && g.status!=="skip" ? `<span class="chip d">已確認</span>` : ""}
        ${g.gap >= 1 ? `<span class="chip w" title="${esc(g.gapWhy)}">⚠ 中斷約 ${Math.round(g.gap)} 秒</span>` : ""}
        ${g.audioLost && !hasAudio(g) ? `<span class="chip">音檔遺失</span>` : ""}
        <span class="acts">${hasAudio(g) ? `<button type="button" data-act="play" aria-label="播放第 ${g.seq} 段">▶ 播放</button>` : ""}<button type="button" data-act="open">審閱</button></span>
        ${g.err && active ? `<span class="note err">${esc(g.err.slice(0,140))}</span>` : ""}
      </div>
    </div></div>`;
}
/* 播放：先用原檔，瀏覽器不支援（例如 iPhone 錄的分段 MP4）時自動轉成 WAV */
const wavCache = new Map();
async function rawPlayBlob(g){
  if (g.blob) { const ext = g.ext || extOf(g.blob.type) || "webm"; return g.blob.type ? g.blob : new Blob([g.blob], {type:mimeOf("x." + ext)}); }
  return (await segAudio(g)).blob;
}
async function wavUrl(g){
  if (wavCache.has(g.id)) return wavCache.get(g.id);
  const src = await rawPlayBlob(g);
  if (!src.size) throw new Error("音檔是空的");
  const pcm = src.type === "audio/wav" ? null : await Promise.race([decodeTo16k(src), sleep(15000).then(() => { throw new Error("轉換逾時"); })]).catch(e => {
    throw new Error(/webm/.test(src.type) && IS_WEBKIT ? "這個瀏覽器無法播放 WebM 錄音，請改用電腦上的 Chrome 開啟（或從 Drive 下載）" : "這個瀏覽器無法解碼此音檔（" + e.message + "）");
  });
  const url = URL.createObjectURL(pcm ? wav16(pcm) : src);
  wavCache.set(g.id, url);
  if (wavCache.size > 30) { const k = wavCache.keys().next().value; URL.revokeObjectURL(wavCache.get(k)); wavCache.delete(k); }
  return url;
}
const player = new Audio(); let playerUrl = "";
async function playSeg(g){
  try {
    if (wavCache.has(g.id)) { player.src = wavCache.get(g.id); await player.play(); return; }
    if (playerUrl) URL.revokeObjectURL(playerUrl);
    playerUrl = URL.createObjectURL(await rawPlayBlob(g)); player.src = playerUrl;
    try { await player.play(); return; }
    catch(e) { if (e.name === "NotAllowedError") throw e; }
    toast("轉換音檔格式中…");
    player.src = await wavUrl(g);
    try { await player.play(); } catch(e) { if (e.name === "NotAllowedError") toast("已轉換完成，請再按一次播放"); else throw e; }
  } catch(e) { toast("無法播放：" + e.message); }
}
$("#segList").addEventListener("click", e => {
  const row = e.target.closest(".seg"); if (!row) return;
  const g = segs.get(row.dataset.id); if (!g) return;
  const b = e.target.closest("button[data-act]");
  if (b && b.dataset.act==="play") return playSeg(g);
  if (b || e.target.closest(".txt")) openReview(g.id);
});
$("#segList").addEventListener("keydown", e => { if ((e.key==="Enter"||e.key===" ") && e.target.classList.contains("txt")) { e.preventDefault(); openReview(e.target.closest(".seg").dataset.id); } });
function showTab(t){
  $$(".tabs button").forEach(x => x.classList.toggle("on", x.dataset.tab===t));
  ["segs","merged","org"].forEach(k => $("#p-"+k).hidden = k!==t);
  drawTimeline();
}
$$(".tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));

/* ================= 逐段審閱：檢視切換、收合、時間軸、問題清單、閱讀模式、分章 ================= */
const UI = Object.assign({view:"list", ch:"", collapse:true, order:"desc"}, LS.get("ui", {}));
const saveUI = () => LS.set("ui", UI);
const expanded = new Set();          // 使用者切換過的收合列／章節
let forceShow = null;                // 時間軸跳轉時強制展開的段落
const isOk = g => ((g.status==="done" && !needsReview(g)) || g.status==="skip") && g.id !== rvId && g.id !== forceShow;
const fmtMin = s => s >= 60 ? `約 ${Math.round(s/60)} 分鐘` : `${Math.round(s)} 秒`;
function chaptersOf(list){
  if (!list.length || !UI.ch) return [{key:"", title:"", segs:list}];
  const out = [];
  if (UI.ch === "time") {
    const t0 = list[0].at;
    for (const g of list) { const i = Math.floor((g.at - t0) / 300000); let c = out[out.length-1]; if (!c || c.i !== i) { c = {i, key:"t"+i, segs:[]}; out.push(c); } c.segs.push(g); }
    out.forEach((c, n) => c.title = `第 ${n+1} 章　${clock(c.segs[0].at).slice(0,5)}–${clock(c.segs[c.segs.length-1].at).slice(0,5)}`);
    return out;
  }
  const chs = (cur.chapters || []).slice().sort((a,b) => a.start - b.start);
  if (!chs.length) return [{key:"", title:"", segs:list}];
  for (const g of list) {
    let idx = -1; for (let k = 0; k < chs.length; k++) if (chs[k].start <= g.seq) idx = k;
    let c = out[out.length-1];
    if (!c || c.idx !== idx) { c = {idx, key:"p"+(idx<0?"0":chs[idx].start), title: idx<0 ? "開頭" : chs[idx].title, segs:[]}; out.push(c); }
    c.segs.push(g);
  }
  out.forEach((c, n) => c.title = `第 ${n+1} 章　${c.title}`);
  return out;
}
function segItem(g){ return {key:g.id, v:g._v + "|" + (g.id===rvId), html:() => rowHTML(g)}; }
function buildItems(list){
  const items = [];
  let chs = chaptersOf(list);
  if (UI.order === "desc") chs = chs.reverse().map(c => ({...c, segs:c.segs.slice().reverse()}));
  for (const ch of chs) {
    if (ch.key) {
      const rv = ch.segs.filter(needsReview).length, dur = ch.segs.reduce((s,g)=>s+(+g.dur||0),0);
      const def = rv > 0 || ch.segs.some(g => g.id===forceShow || g.id===rvId);
      const open = expanded.has("ch:"+ch.key) ? !def : def;
      items.push({key:"ch:"+ch.key, v:[ch.title, ch.segs.length, rv, open].join("|"),
        html:() => `<div class="chhead${rv?" need":""}"><button type="button" data-tog="ch:${esc(ch.key)}" aria-expanded="${open}"><span class="tw">${open?"▾":"▸"}</span><strong>${esc(ch.title)}</strong><span class="note">${ch.segs.length} 段 · ${fmtMin(dur)}</span>${rv?`<span class="chip e">待審 ${rv}</span>`:`<span class="chip d">無問題</span>`}</button></div>`});
      if (!open) continue;
    }
    let run = [];
    const flush = () => {
      if (run.length >= 3 && UI.collapse && filter === "all") {
        const r = run, k = "run:" + r[0].seq, open = expanded.has(k), a = Math.min(r[0].seq, r[r.length-1].seq), b = Math.max(r[0].seq, r[r.length-1].seq);
        const dur = run.reduce((s,g)=>s+(+g.dur||0),0), sk = run.filter(g=>g.status==="skip").length;
        items.push({key:k, v:[b, run.length, open].join("|"), html:() => `<div class="runrow"><button type="button" data-tog="${k}" aria-expanded="${open}"><span class="tw">${open?"▾":"▸"}</span>第 ${a}–${b} 段沒有問題<span class="note">${r.length} 段${sk?`（含 ${sk} 段略過）`:""} · ${fmtMin(dur)}</span></button></div>`});
        if (open) run.forEach(g => items.push(segItem(g)));
      } else run.forEach(g => items.push(segItem(g)));
      run = [];
    };
    for (const g of ch.segs) { if (isOk(g)) run.push(g); else { flush(); items.push(segItem(g)); } }
    flush();
  }
  return items;
}
function reconcile(box, items){
  box.querySelectorAll(":scope > :not([data-k])").forEach(e => e.remove());
  const have = new Map([...box.children].map(el => [el.dataset.k, el])), order = [];
  for (const it of items) {
    let el = have.get(it.key);
    if (!el || el._v !== it.v) { const d = document.createElement("div"); d.innerHTML = it.html(); const n = d.firstElementChild; n.dataset.k = it.key; n._v = it.v; if (el) el.replaceWith(n); el = n; }
    have.delete(it.key); order.push(el);
  }
  have.forEach(el => el.remove());
  let prev = null;
  for (const el of order) { if (prev ? prev.nextElementSibling !== el : box.firstElementChild !== el) { if (prev) prev.after(el); else box.prepend(el); } prev = el; }
}
function drawList(){
  const box = $("#segList"), all = sorted(), list = all.filter(FILTERS[filter].fn);
  if (!all.length) { box.innerHTML = '<p class="empty">按紅色按鈕開始錄音，或上傳音檔。說話停頓時會自動切段送出；轉錄、幻聽檢查與修正都在背景排隊進行，錄音不用等。</p>'; return; }
  if (!list.length) { box.innerHTML = `<p class="empty">「${FILTERS[filter].name}」目前沒有段落。</p>`; return; }
  reconcile(box, buildItems(list));
}
$("#segList").addEventListener("click", e => {
  const t = e.target.closest("button[data-tog]"); if (!t) return;
  const k = t.dataset.tog; expanded.has(k) ? expanded.delete(k) : expanded.add(k); drawList();
}, true);

/* 時間軸 */
const tl = $("#tl");
function drawTimeline(){
  const list = sorted(), show = !$("#p-segs").hidden && list.length > 0;
  tl.hidden = !show; if (!show) return;
  const w = tl.clientWidth || 300, h = 14, dpr = window.devicePixelRatio || 1;
  if (tl.width !== Math.round(w*dpr)) { tl.width = Math.round(w*dpr); tl.height = h*dpr; }
  const ctx = tl.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
  const cs = getComputedStyle(document.documentElement), col = k => cs.getPropertyValue(k).trim();
  const n = list.length, bw = w/n, gap = bw > 4 ? 1 : 0;
  ctx.fillStyle = col("--sunk"); ctx.fillRect(0, 0, w, h);
  list.forEach((g,i) => {
    if (needsReview(g)) return;
    ctx.fillStyle = g.status==="done" ? col("--accent") : g.status==="skip" ? col("--line") : col("--warn");
    ctx.globalAlpha = g.status==="done" ? 0.55 : 1;
    ctx.fillRect(i*bw, 3, Math.max(1, bw-gap), h-6);
  });
  ctx.globalAlpha = 1; ctx.fillStyle = col("--err");
  list.forEach((g,i) => { if (needsReview(g)) ctx.fillRect(Math.min(w-3, i*bw), 0, Math.max(3, bw-gap), h); });
  ctx.fillStyle = col("--warn");
  list.forEach((g,i) => { if (g.gap >= 1) { const x = Math.min(w-4, i*bw); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x+6, 0); ctx.lineTo(x+3, 6); ctx.fill(); } });
  const ri = list.findIndex(g => g.id===rvId);
  if (ri >= 0) { ctx.fillStyle = col("--fg"); ctx.fillRect(Math.min(w-3, ri*bw), h-3, Math.max(3, bw-gap), 3); }
}
function tlIndex(e){ const r = tl.getBoundingClientRect(), list = sorted(); return list[Math.max(0, Math.min(list.length-1, Math.floor((e.clientX - r.left) / r.width * list.length)))]; }
tl.addEventListener("mousemove", e => { const g = tlIndex(e); if (g) tl.title = `#${g.seq} ${clock(g.at)}　${(STAT[g.status]||[g.status])[0]}${needsReview(g)?"・待審閱":""}　${(g.text||g.raw||"").slice(0,30)}`; });
tl.addEventListener("click", e => { const g = tlIndex(e); if (g) jumpTo(g); });
function jumpTo(g){
  if (UI.view !== "list") setView("list");
  if (!FILTERS[filter].fn(g)) setFilter("all");
  forceShow = g.id; drawList();
  const row = document.querySelector(`.seg[data-id="${CSS.escape(g.id)}"]`);
  if (row) { row.scrollIntoView({block:"center", behavior:"smooth"}); row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 1600); }
  if (needsReview(g)) openReview(g.id);
  setTimeout(() => { forceShow = null; }, 4000);
}

/* 問題清單（以問題為單位審閱） */
function issueEntries(){
  const out = [];
  for (const g of sorted()) {
    if (g.status === "skip") continue;
    g.issues.forEach((i, k) => { if (!i.state) out.push({g, k, i}); });
    if (needsReview(g) && !openIssues(g).length) out.push({g, seg:true});
  }
  return out;
}
const sameKey = i => i.quote + "\u0000" + (i.suggest ?? "\u0001");
function ctxHTML(g, i){
  const t = g.text || g.raw || "", p = t.indexOf(i.quote);
  if (p < 0) return esc(t.slice(0, 90)) + (t.length > 90 ? "…" : "");
  const a = Math.max(0, p-30), b = Math.min(t.length, p + i.quote.length + 30);
  return (a > 0 ? "…" : "") + esc(t.slice(a, p)) + `<mark class="${TYPECLS[i.type]||"hl-s"}">${esc(i.quote)}</mark>` + esc(t.slice(p + i.quote.length, b)) + (b < t.length ? "…" : "");
}
function drawIssues(){
  const box = $("#issueList"), ents = issueEntries();
  const groups = new Map(); ents.forEach(x => { if (x.i && x.i.suggest != null) { const k = sameKey(x.i); groups.set(k, (groups.get(k)||0) + 1); } });
  const nI = ents.filter(x => x.i).length, nS = ents.length - nI;
  if (!ents.length) { box.innerHTML = '<p class="empty">沒有待處理的問題了。可以到「整理稿」整理全文。</p>'; return; }
  box.innerHTML = `<p class="note" style="margin:0 0 8px">待處理 ${ents.length} 項：字句問題 ${nI}、整段可疑 ${nS}。處理完的項目會自動消失。</p>` + ents.map(x => {
    const g = x.g, head = `<button type="button" class="ref" data-op="open" data-id="${esc(g.id)}">#${g.seq}</button><span class="note">${clock(g.at)}</span>`;
    if (x.seg) {
      const why = [...g.flags.filter(f => !/一致/.test(f)), g.orgNote && "整理時標註：" + g.orgNote, g.status.startsWith("err") && (g.err || "處理失敗")].filter(Boolean);
      return `<div class="icard seg-c"><div class="ihead">${head}<span class="chip e">整段可疑</span>${why.map(f => `<span class="chip w">${esc(f)}</span>`).join("")}</div>
        <div class="ictx">${esc((g.text || g.raw || "（沒有文字）").slice(0, 160))}</div>
        <div class="row tight">${hasAudio(g)?`<button type="button" data-op="play" data-id="${esc(g.id)}">播放</button>`:""}<button type="button" data-op="ok" data-id="${esc(g.id)}">確認沒問題</button>${hasAudio(g)?`<button type="button" data-op="v3" data-id="${esc(g.id)}">用 large-v3 重辨識</button>`:""}<button type="button" data-op="skip" data-id="${esc(g.id)}">從逐字稿移除</button><button type="button" data-op="open" data-id="${esc(g.id)}">開啟段落</button></div></div>`;
    }
    const i = x.i, same = i.suggest != null ? (groups.get(sameKey(i)) || 1) : 1;
    return `<div class="icard"><div class="ihead">${head}<span class="chip ${i.type==="疑似幻聽"?"e":"w"}">${esc(i.type)}</span>${i.note?`<span class="note">${esc(i.note)}</span>`:""}</div>
      <div class="ictx">${ctxHTML(g, i)}</div>
      ${i.suggest ? `<div class="note">建議改成「${esc(i.suggest)}」</div>` : i.suggest === "" ? `<div class="note">建議刪除</div>` : ""}
      <div class="row tight">${i.suggest!=null?`<button type="button" class="primary" data-op="acc" data-id="${esc(g.id)}" data-k="${x.k}">${i.suggest===""?"刪除":"採用"}</button>`:""}${same>1?`<button type="button" data-op="accAll" data-id="${esc(g.id)}" data-k="${x.k}">相同的 ${same} 處一起${i.suggest===""?"刪除":"採用"}</button>`:""}${i.suggest!==""?`<button type="button" data-op="del" data-id="${esc(g.id)}" data-k="${x.k}">刪除這句</button>`:""}<button type="button" data-op="ign" data-id="${esc(g.id)}" data-k="${x.k}">保留原文</button>${hasAudio(g)?`<button type="button" data-op="play" data-id="${esc(g.id)}">播放</button>`:""}</div></div>`;
  }).join("");
}
function applyIssueOp(g, k, op){
  const i = g.issues[k]; if (!i || i.state) return;
  if (op === "ign") { i.state = "ignored"; computeRisk(g); touch(g); saveSeg(g, true); return; }
  const t = g.text || "", rep = op === "acc" ? (i.suggest ?? "") : "";
  let nt = t.includes(i.quote) ? t.replace(i.quote, rep) : t;
  nt = nt.replace(/([，。、？！：])\1+/g, "$1").replace(/^[，。、]+/, "").trim();
  i.state = "fixed"; editText(g, nt, t); saveSeg(g, true);
  if (rvId === g.id && document.activeElement !== ta) ta.value = nt;
}
$("#issueList").addEventListener("click", e => {
  const b = e.target.closest("button[data-op]"); if (!b) return;
  const g = segs.get(b.dataset.id); if (!g) return; const op = b.dataset.op, k = +b.dataset.k;
  if (op === "open") return openReview(g.id);
  if (op === "play") return playSeg(g);
  if (op === "ok") { g.reviewed = true; g.orgNote = ""; touch(g); saveSeg(g, true); }
  else if (op === "v3") { redo(g, V3); toast(`#${g.seq} 已排入 large-v3 重辨識`); }
  else if (op === "skip") { g.userSkip = true; g.status = "skip"; g.reviewed = true; touch(g); saveSeg(g, true); }
  else if (op === "accAll") { const key = sameKey(g.issues[k]); let n = 0; for (const x of issueEntries()) if (x.i && sameKey(x.i) === key) { applyIssueOp(x.g, x.k, "acc"); n++; } toast(`已套用 ${n} 處`); }
  else applyIssueOp(g, k, op);
  render(); if (rvId) fillReview(false);
});

/* 閱讀模式 */
function drawRead(){
  const box = $("#readDoc"), list = sorted().filter(g => g.status !== "skip" && (g.text || g.raw));
  if (!list.length) { box.innerHTML = '<p class="empty">還沒有內容。</p>'; return; }
  let html = "";
  for (const ch of chaptersOf(list)) {
    if (ch.key) html += `<h3>${esc(ch.title)}</h3>`;
    let p = [], len = 0;
    const flushP = () => { if (p.length) html += "<p>" + p.join("") + "</p>"; p = []; len = 0; };
    for (const g of ch.segs) {
      const t = g.text || g.raw;
      p.push(`<span class="rs${needsReview(g)?" flag":""}${g.status!=="done"?" pend":""}" data-id="${esc(g.id)}"><sup>${g.seq}</sup>${hlText(g)}</span>`);
      len += t.length;
      if (len > 220 && /[。！？」]$/.test(t.trim())) flushP();
    }
    flushP();
  }
  box.innerHTML = html;
}
$("#readDoc").addEventListener("click", e => { const s = e.target.closest(".rs"); if (s) openReview(s.dataset.id); });

/* 依主題分章（AI） */
const TOPIC_SYS = `你是編輯。輸入是一份逐字稿的段落清單，每行開頭是段號 [#n]，後面是該段開頭的文字。請依內容把它分成主題章節。
只輸出 JSON：{"chapters":[{"start":起始段號,"title":"12 字以內的小標"}]}
規則：start 依序遞增，第一章的 start 是輸入中最小的段號；每章至少 3 段；主題沒有明顯改變就不要切；標題用台灣正體中文。`;
async function analyzeTopics(){
  readForm(); if (!S.key) return toast("請先設定 API key");
  const list = sorted().filter(g => g.status==="done" && g.text);
  if (list.length < 6) return toast("完成的段落還太少，多錄一些再分析");
  const T = TIER(), per = S.tier==="dev" ? 80 : 40, lines = list.map(g => `[#${g.seq}] ${g.text.replace(/\s+/g,"").slice(0, per)}`);
  const chunks = []; let b = "";
  for (const l of lines) { if (b && b.length + l.length > T.org * 2) { chunks.push(b); b = ""; } b += (b ? "\n" : "") + l; }
  if (b) chunks.push(b);
  const btn = $("#topicBtn"); btn.disabled = true; let all = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      btn.textContent = `分析主題中 ${i+1}/${chunks.length}…`;
      const j = await groq("chat/completions", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({
        model:S.orgModel, temperature:0.2, reasoning_effort:"low", max_completion_tokens:1500, response_format:{type:"json_object"},
        messages:[{role:"system", content:TOPIC_SYS}, {role:"user", content:chunks[i]}]})});
      let o = {}; try { o = JSON.parse(j.choices?.[0]?.message?.content || "{}"); } catch {}
      (o.chapters || []).forEach(c => { const s = Number(c.start); if (s && c.title) all.push({start:s, title:String(c.title).slice(0, 20)}); });
    }
    all = all.sort((a,b) => a.start - b.start).filter((c,i,arr) => !i || c.start !== arr[i-1].start);
    if (!all.length) throw new Error("模型沒有回傳章節");
    cur.chapters = all; cur.chAt = Date.now(); await put("sessions", cur); driveDirty(cur.id);
    toast(`已分成 ${all.length} 章`); render();
  } catch(e) { toast("主題分析失敗：" + e.message); }
  finally { btn.disabled = false; btn.textContent = "重新分析主題"; }
}
$("#topicBtn").onclick = analyzeTopics;

/* 檢視切換 */
function setView(v){
  UI.view = v; saveUI();
  $$("#viewSw button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  $("#segList").hidden = v !== "list"; $("#issueList").hidden = v !== "issues"; $("#readDoc").hidden = v !== "read";
  $("#filters").hidden = v !== "list"; $("#collapseLbl").hidden = v !== "list";
  render();
}
$("#viewSw").addEventListener("click", e => { const b = e.target.closest("button[data-view]"); if (b) setView(b.dataset.view); });
$("#chMode").value = UI.ch; $("#collapseOk").checked = UI.collapse; $("#topicBtn").hidden = UI.ch !== "topic";
$("#chMode").onchange = e => { UI.ch = e.target.value; saveUI(); $("#topicBtn").hidden = UI.ch !== "topic"; if (UI.ch === "topic" && !(cur.chapters||[]).length) analyzeTopics(); render(); };
$("#collapseOk").onchange = e => { UI.collapse = e.target.checked; saveUI(); render(); };
window.addEventListener("resize", () => drawTimeline());
function orderUI(){ $("#orderBtn").textContent = UI.order === "desc" ? "↓ 新到舊" : "↑ 舊到新"; $("#orderBtn").title = UI.order === "desc" ? "目前最新的在最上面，點一下改成最新在下" : "目前最新的在最下面，點一下改成最新在上"; }
$("#orderBtn").onclick = () => { UI.order = UI.order === "desc" ? "asc" : "desc"; saveUI(); orderUI(); render(); };
orderUI();
let lastSegCount = 0;
const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240;
function followNewest(fn){
  const grew = segs.size > lastSegCount, nb = nearBottom(); lastSegCount = segs.size;
  fn();
  if (grew && rec.on && nb) window.scrollTo({top:document.documentElement.scrollHeight, behavior:"smooth"});
}
function drawSegViews(){
  const n = issueEntries().length; const vb = $('#viewSw button[data-view="issues"]'); if (vb) vb.textContent = n ? `問題清單 ${n}` : "問題清單";
  if (UI.view === "list") { if (UI.order === "asc") followNewest(drawList); else { lastSegCount = segs.size; drawList(); } }
  else if (UI.view === "issues") drawIssues(); else drawRead();
  drawTimeline();
}

