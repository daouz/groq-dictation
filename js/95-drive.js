"use strict";
/* ================= Google Drive 同步 ================= */
const CLIENT_ID = "208521973041-e1eoor06r1f6itnbd5dgdcmth3lv3ctc.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER = "application/vnd.google-apps.folder";
const ROOT_NAME = "Groq 連續聽寫";
const drive = {token:"", exp:0, email:LS.get("driveEmail",""), busy:false, dirty:new Set(), last:0, err:"", rootOk:"", t:0, cache:new Map()};
(() => { const t = LS.get("driveTok", null); if (t && t.exp > Date.now() + 60000) { drive.token = t.token; drive.exp = t.exp; } })();
let tokenClient = null;
const driveOn = () => !!drive.token && Date.now() < drive.exp;
const driveWanted = () => !!LS.get("driveWanted", false);
function driveErr(m, status){ const e = new ApiErr(m, status); e.drive = true; return e; }
async function dapi(url, init = {}){
  if (!driveOn()) throw driveErr("需要連線 Google Drive", 401);
  let r;
  try { r = await fetch(url.startsWith("http") ? url : "https://www.googleapis.com/drive/v3/" + url, {...init, headers:{Authorization:"Bearer " + drive.token, ...(init.headers||{})}}); }
  catch { throw driveErr("網路連線失敗", 0); }
  if (r.status === 401) { drive.exp = 0; LS.set("driveTok", null); driveUI(); throw driveErr("Google 授權已到期", 401); }
  if (!r.ok) { let m = "Drive HTTP " + r.status; try { m = (await r.json()).error?.message || m; } catch {} throw driveErr(m, r.status); }
  return r;
}
const qs = s => encodeURIComponent(s);
async function dFind(query, fields = "files(id,name,modifiedTime,appProperties,size)"){
  const r = await dapi(`files?q=${qs(query)}&fields=${qs(fields)}&orderBy=modifiedTime%20desc&pageSize=200&spaces=drive`);
  return (await r.json()).files || [];
}
async function dFolder(name, parent, props){
  const r = await dapi("files?fields=id", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name, mimeType:FOLDER, parents:[parent], appProperties:props||{}})});
  return (await r.json()).id;
}
async function dUpload(meta, blob, fileId){
  const type = blob.type || "application/octet-stream", path = fileId ? "/" + fileId : "", method = fileId ? "PATCH" : "POST";
  if (blob.size > 4.5*1048576) {
    const r = await dapi(`https://www.googleapis.com/upload/drive/v3/files${path}?uploadType=resumable&fields=id`, {method, headers:{"Content-Type":"application/json; charset=UTF-8", "X-Upload-Content-Type":type}, body:JSON.stringify(fileId ? {} : meta)});
    const loc = r.headers.get("Location");
    if (loc) { const r2 = await dapi(loc, {method:"PUT", headers:{"Content-Type":type}, body:blob}); return (await r2.json()).id; }
  }
  const b = "gd" + Math.random().toString(36).slice(2);
  const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(fileId ? {} : meta)}\r\n--${b}\r\nContent-Type: ${type}\r\n\r\n`, blob, `\r\n--${b}--`]);
  const r = await dapi(`https://www.googleapis.com/upload/drive/v3/files${path}?uploadType=multipart&fields=id`, {method, headers:{"Content-Type":"multipart/related; boundary=" + b}, body});
  return (await r.json()).id;
}
async function driveBlob(id, type){
  if (drive.cache.has(id)) return drive.cache.get(id);
  const b = await (await dapi(`files/${id}?alt=media`)).blob();
  const out = type ? new Blob([b], {type}) : b;
  drive.cache.set(id, out); if (drive.cache.size > 40) drive.cache.delete(drive.cache.keys().next().value);
  return out;
}
async function dRoot(){
  let id = LS.get("driveRoot", "");
  if (id && drive.rootOk === id) return id;
  if (id) { try { const j = await (await dapi(`files/${id}?fields=id,trashed`)).json(); if (!j.trashed) { drive.rootOk = id; return id; } } catch(e) { if (e.status !== 404) throw e; } }
  const f = await dFind(`name='${ROOT_NAME}' and mimeType='${FOLDER}' and 'root' in parents and trashed=false`);
  id = f[0]?.id || await dFolder(ROOT_NAME, "root", {gdRoot:"1"});
  LS.set("driveRoot", id); drive.rootOk = id; return id;
}
async function dSessFolder(sess){
  if (sess.driveFolder) return sess.driveFolder;
  const root = await dRoot();
  const f = await dFind(`'${root}' in parents and mimeType='${FOLDER}' and appProperties has { key='gdSid' and value='${sess.id}' } and trashed=false`);
  sess.driveFolder = f[0]?.id || await dFolder(sess.name, root, {gdSid:sess.id});
  sess.driveFolderName = sess.name; await put("sessions", sess);
  return sess.driveFolder;
}
async function dPutFile(sess, key, name, blob){
  sess.driveFiles = sess.driveFiles || {};
  const meta = {name, parents:[sess.driveFolder], appProperties:{gdFile:key}};
  let id = sess.driveFiles[key];
  try { id = await dUpload(meta, blob, id); }
  catch(e) { if (id && e.status === 404) id = await dUpload(meta, blob); else throw e; }
  if (sess.driveFiles[key] !== id) { sess.driveFiles[key] = id; await put("sessions", sess); }
}
async function sessionMeta(sess, list, srcs){
  return {format:"groq-dictation", version:2, exported:new Date().toISOString(), session:sess,
    segments:list.map(g => { const {blob, _v, _ab, _abFrom, ...r} = g; return r; }),
    sources:srcs.map(s => ({id:s.id, name:s.name, type:s.type, driveId:s.driveId||null}))};
}
function driveDirty(sid){
  if (!sid) return; drive.dirty.add(sid);
  clearTimeout(drive.t); drive.t = setTimeout(() => driveSync(), 20000);
}
async function driveSync(force){
  if (drive.busy || !cur || !db) return;
  if (!driveOn()) { driveUI(); return; }
  if (!S.driveAuto && !force) { driveUI(); return; }
  drive.busy = true; drive.err = ""; driveUI();
  const sess = cur;
  try {
    const folder = await dSessFolder(sess);
    if (sess.driveFolderName !== sess.name) {
      await dapi(`files/${folder}`, {method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name:sess.name})});
      sess.driveFolderName = sess.name; await put("sessions", sess);
    }
    let changed = false;
    for (const t of sess.takes || []) {
      if (t.ended && t.bytes && !t.driveId) {
        const blob = await takeBlob(sess.id, t);
        t.driveId = await dUpload({name:`完整錄音_${new Date(t.at).toLocaleString("zh-TW",{hour12:false}).replace(/[\/:]/g,"-")}.${t.ext || "webm"}`, parents:[folder], appProperties:{gdTake:t.id}}, blob);
        await put("sessions", sess); changed = true; renderTakes();
      }
    }
    for (const s of await bySid("sources", sess.id)) {
      if (s.blob && !s.driveId) { s.driveId = await dUpload({name:"原始_" + s.name, parents:[folder], appProperties:{gdSrc:s.id}}, s.blob); await put("sources", s); changed = true; }
    }
    for (const g of sorted()) {
      if (cur !== sess) break;
      if (g.blob && !g.driveAudioId) {
        const ext = g.ext || extOf(g.blob.type) || "webm";
        g.driveAudioId = await dUpload({name:`${String(g.seq).padStart(4,"0")}.${ext}`, parents:[folder], appProperties:{gdSeq:String(g.seq)}}, g.blob);
        await put("segs", g); changed = true; driveUI();
      }
    }
    if (changed) drive.dirty.add(sess.id);
    if (cur === sess && (drive.dirty.has(sess.id) || force)) {
      drive.dirty.delete(sess.id);
      const meta = await sessionMeta(sess, sorted(), await bySid("sources", sess.id));
      await dPutFile(sess, "json", "session.json", new Blob([JSON.stringify(meta, null, 1)], {type:"application/json"}));
      await dPutFile(sess, "merged", "合併稿.txt", new Blob([mergedText()], {type:"text/plain"}));
      if (sess.organized) await dPutFile(sess, "org", "整理稿.md", new Blob([sess.organized], {type:"text/markdown"}));
    }
    drive.last = Date.now();
  } catch(e) {
    drive.err = e.message; drive.dirty.add(sess.id);
  } finally { drive.busy = false; driveUI(); }
}
function driveConnect(){
  if (!window.google?.accounts?.oauth2) return toast("Google 登入元件還在載入，請幾秒後再按一次");
  if (!tokenClient) tokenClient = google.accounts.oauth2.initTokenClient({client_id:CLIENT_ID, scope:SCOPE, callback:onToken,
    error_callback:e => toast("Google 登入沒有完成：" + (e?.message || e?.type || "已取消"))});
  const opt = {prompt: LS.get("driveConsent", false) ? "" : "consent"};
  if (drive.email) opt.login_hint = drive.email;
  tokenClient.requestAccessToken(opt);
}
async function onToken(r){
  if (r.error) return toast("Google 授權失敗：" + r.error);
  if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) return toast("沒有勾選 Google Drive 權限，請重新連線並允許");
  drive.token = r.access_token; drive.exp = Date.now() + (Number(r.expires_in || 3600) - 120) * 1000;
  LS.set("driveTok", {token:drive.token, exp:drive.exp}); LS.set("driveConsent", true); LS.set("driveWanted", true);
  try { const a = await (await dapi("about?fields=user(emailAddress)")).json(); drive.email = a.user?.emailAddress || ""; LS.set("driveEmail", drive.email); } catch {}
  banner("drv"); toast("已連線 Google Drive");
  if (cur) drive.dirty.add(cur.id);
  lanes.tx.until = 0; pump(); driveSync(true);
}
function driveOff(){
  try { if (drive.token) google.accounts.oauth2.revoke(drive.token, () => {}); } catch {}
  drive.token = ""; drive.exp = 0; LS.set("driveTok", null); LS.set("driveWanted", false); banner("drv"); driveUI(); toast("已中斷 Google Drive");
}
function drivePending(){ let n = 0; segs.forEach(g => { if (g.blob && !g.driveAudioId) n++; }); return n; }
function driveUI(){
  const on = driveOn(), pend = drivePending();
  const info = $("#drvInfo");
  if (info) info.textContent = on
    ? `已連線${drive.email ? "：" + drive.email : ""}。${drive.busy ? "同步中…" : pend ? `待上傳音檔 ${pend} 段。` : "音檔都已上傳。"}${drive.last ? " 上次同步 " + clock(drive.last) + "。" : ""}${drive.err ? " 錯誤：" + drive.err : ""}`
    : driveWanted() ? "Google 授權每小時到期，請按「連線 Google Drive」重新連線。本機資料不受影響，連線後會自動補傳。" : "尚未連線。連線後，每個工作階段會在你的 Drive「" + ROOT_NAME + "」資料夾裡自動備份音檔、逐字稿與整理稿。";
  const set = (id, v) => { const el = $(id); if (el) el.hidden = !v; };
  set("#drvConn", !on); set("#drvSync", on); set("#drvListBtn", on); set("#drvOff", on || driveWanted());
  if (driveWanted() && !on) banner("drv", "Google Drive 需要重新連線才能繼續同步（本機照常存檔）。"); else banner("drv");
  const chip = $("#drvChip");
  if (chip) { chip.hidden = !(on || driveWanted()); chip.textContent = !on ? "Drive 未連線" : drive.busy ? "Drive 同步中" : drive.err ? "Drive 同步失敗" : pend ? `Drive 待上傳 ${pend}` : "Drive 已同步"; chip.className = "chip " + (!on || drive.err ? "e" : drive.busy || pend ? "t" : "d"); }
}
async function driveListSessions(){
  const box = $("#drvList"); box.innerHTML = '<p class="note">讀取中…</p>';
  try {
    const root = await dRoot();
    const fs = await dFind(`'${root}' in parents and mimeType='${FOLDER}' and trashed=false`);
    box.innerHTML = fs.length ? fs.map(f => { const sid = f.appProperties?.gdSid; const local = sessions.some(s => s.id === sid);
      return `<div class="hist"><span class="t" style="color:var(--fg)">${esc(f.name)}</span><span class="note">${new Date(f.modifiedTime).toLocaleString("zh-TW",{hour12:false})}</span><button type="button" data-dopen="${esc(f.id)}">${local ? "切換到這個" : "開啟"}</button></div>`; }).join("")
      : '<p class="note">Drive 上還沒有工作階段。</p>';
  } catch(e) { box.innerHTML = `<p class="note err">${esc(e.message)}</p>`; }
}
async function driveOpen(fid){
  if (rec.on) return toast("請先停止錄音");
  const f = await dFind(`'${fid}' in parents and name='session.json' and trashed=false`, "files(id)");
  if (!f.length) throw new Error("這個資料夾裡沒有 session.json");
  const m = await (await dapi(`files/${f[0].id}?alt=media`)).json();
  if (m.format !== "groq-dictation" || !m.session?.id) throw new Error("格式不符");
  const sid = m.session.id;
  if (sessions.some(s => s.id === sid)) { await switchSession(sid); toast("本機已有這個工作階段，已直接開啟（以本機內容為準）"); return; }
  const s = {...m.session, driveFolder:fid};
  await put("sessions", s);
  for (const src of m.sources || []) await put("sources", {id:src.id, sid, name:src.name, type:src.type, blob:null, driveId:src.driveId || null});
  for (const r of m.segments || []) {
    const g = normalize({...r, sid, blob:null});
    if (g.status === "transcribing") g.status = "queued"; if (g.status === "fixing") g.status = "transcribed";
    await put("segs", g);
  }
  sessions.unshift(s); await switchSession(sid);
  toast(`已從 Drive 開啟 ${(m.segments||[]).length} 段，音檔會在播放或重辨識時從 Drive 讀取`);
}
$("#drvConn").onclick = driveConnect;
$("#drvOff").onclick = driveOff;
$("#drvSync").onclick = () => { if (cur) drive.dirty.add(cur.id); driveSync(true); };
$("#drvListBtn").onclick = driveListSessions;
$("#drvList").addEventListener("click", async e => { const b = e.target.closest("button[data-dopen]"); if (!b) return; b.disabled = true; try { await driveOpen(b.dataset.dopen); driveListSessions(); } catch(err) { toast("開啟失敗：" + err.message); b.disabled = false; } });
setInterval(() => { driveUI(); if (driveOn()) driveSync(); }, 45000);

