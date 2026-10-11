"use strict";
/* ================= 匯出（下載、複製） ================= */
function download(name, data, type){
  const blob = data instanceof Blob ? data : new Blob([data], {type});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
async function copy(text){ try { await navigator.clipboard.writeText(text); toast("已複製"); } catch { toast("無法複製，請手動選取"); } }
const fname = ext => cur.name.replace(/[\\/:*?"<>|\s]+/g, "_") + "." + ext;
$("#copyMerged").onclick = () => copy(mergedText());
$("#dlMerged").onclick = () => download(fname("txt"), mergedText(), "text/plain;charset=utf-8");
$("#copyOrg").onclick = () => cur.organized ? copy(cur.organized) : toast("還沒有整理稿");
$("#dlOrg").onclick = () => cur.organized ? download(fname("md"), cur.organized, "text/markdown;charset=utf-8") : toast("還沒有整理稿");

/* ================= ZIP（不壓縮，音檔本身已是 Opus） ================= */
const CRC = (() => { const t = new Uint32Array(256); for (let n=0;n<256;n++){ let c=n; for (let k=0;k<8;k++) c = c&1 ? 0xEDB88320^(c>>>1) : c>>>1; t[n]=c>>>0; } return t; })();
function crc32(u8){ let c = 0xFFFFFFFF; for (let i=0;i<u8.length;i++) c = CRC[(c^u8[i])&255] ^ (c>>>8); return (c^0xFFFFFFFF)>>>0; }
async function makeZip(files){
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  const d = new Date(), dt = (d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1), dd = ((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate();
  for (const f of files) {
    const data = typeof f.data === "string" ? enc.encode(f.data) : new Uint8Array(await f.data.arrayBuffer());
    const name = enc.encode(f.name), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0,0x04034b50,true); lh.setUint16(4,20,true); lh.setUint16(6,0x0800,true); lh.setUint16(8,0,true); lh.setUint16(10,dt,true); lh.setUint16(12,dd,true);
    lh.setUint32(14,crc,true); lh.setUint32(18,data.length,true); lh.setUint32(22,data.length,true); lh.setUint16(26,name.length,true); lh.setUint16(28,0,true);
    parts.push(lh, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0,0x02014b50,true); ch.setUint16(4,20,true); ch.setUint16(6,20,true); ch.setUint16(8,0x0800,true); ch.setUint16(10,0,true); ch.setUint16(12,dt,true); ch.setUint16(14,dd,true);
    ch.setUint32(16,crc,true); ch.setUint32(20,data.length,true); ch.setUint32(24,data.length,true); ch.setUint16(28,name.length,true); ch.setUint32(42,off,true);
    cen.push(ch, name); off += 30 + name.length + data.length;
  }
  const cs = cen.reduce((s,x) => s + x.byteLength, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0,0x06054b50,true); end.setUint16(8,files.length,true); end.setUint16(10,files.length,true); end.setUint32(12,cs,true); end.setUint32(16,off,true);
  return new Blob([...parts, ...cen, end], {type:"application/zip"});
}
async function readZip(blob){
  const buf = new Uint8Array(await blob.arrayBuffer()), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let e = buf.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("不是有效的 ZIP 檔");
  const n = dv.getUint16(e+10, true); let p = dv.getUint32(e+16, true); const dec = new TextDecoder(), out = {};
  for (let i=0;i<n;i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("ZIP 目錄損壞");
    const method = dv.getUint16(p+10,true), csize = dv.getUint32(p+20,true), nl = dv.getUint16(p+28,true), xl = dv.getUint16(p+30,true), cl = dv.getUint16(p+32,true), lo = dv.getUint32(p+42,true);
    const name = dec.decode(buf.subarray(p+46, p+46+nl));
    const start = lo + 30 + dv.getUint16(lo+26,true) + dv.getUint16(lo+28,true);
    let data = buf.subarray(start, start + csize);
    if (method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    else if (method !== 0) throw new Error("不支援的 ZIP 壓縮方式");
    out[name] = data; p += 46 + nl + xl + cl;
  }
  return out;
}
function segReport(){
  return sorted().map(g => `#${g.seq}  ${new Date(g.at).toLocaleString("zh-TW",{hour12:false})}  ${g.dur?Number(g.dur).toFixed(1)+"s":""}  ${STAT[g.status]?.[0]||g.status}${g.model?"  "+MNAME(g.model):""}${g.reviewed?"  已確認":""}${g.flags.length?"\n警示："+g.flags.join("、"):""}${openIssues(g).length?"\n待確認："+openIssues(g).map(i=>i.type+"「"+i.quote+"」").join("；"):""}\n校正：${g.text||""}\n原始：${g.raw||""}\n`).join("\n");
}
async function exportZip(){
  if (!cur) return;
  toast("打包中…");
  const pad = n => String(n).padStart(4, "0"), files = [], list = sorted();
  const segsMeta = list.map(g => { const {blob, _v, _ab, _abFrom, ...r} = g; r.audioFile = blob ? `audio/${pad(g.seq)}.${g.ext||extOf(blob.type)||"webm"}` : null; return r; });
  const srcs = await bySid("sources", cur.id);
  const srcMeta = srcs.map(s => ({id:s.id, name:s.name, type:s.type, file:`sources/${s.id}.${(s.name.split(".").pop()||"bin").toLowerCase()}`}));
  files.push({name:"session.json", data:JSON.stringify({format:"groq-dictation", version:2, exported:new Date().toISOString(), session:cur, segments:segsMeta, sources:srcMeta}, null, 1)});
  files.push({name:"合併稿.txt", data:mergedText()});
  files.push({name:"逐段校對.txt", data:segReport()});
  if (cur.organized) files.push({name:"整理稿.md", data:cur.organized});
  list.forEach((g, i) => { if (g.blob) files.push({name:segsMeta[i].audioFile, data:g.blob}); });
  srcs.forEach((s, i) => files.push({name:srcMeta[i].file, data:s.blob}));
  for (const t of (cur.takes || []).filter(t => t.ended && t.bytes)) files.push({name:`完整錄音/${t.id}.${t.ext || "webm"}`, data:await takeBlob(cur.id, t)});
  try { const z = await makeZip(files); download(fname("zip"), z); toast("已匯出 " + MB(z.size)); LS.set("lastExport_"+cur.id, Date.now()); banner("backup"); }
  catch(e){ toast("匯出失敗：" + e.message); }
}
async function importZip(file){
  const z = await readZip(file), dec = new TextDecoder();
  if (!z["session.json"]) throw new Error("找不到 session.json，這不是本工具匯出的 ZIP");
  const m = JSON.parse(dec.decode(z["session.json"]));
  if (m.format !== "groq-dictation") throw new Error("格式不符");
  const sid = "s" + Date.now();
  const s = {...m.session, id:sid, name:(m.session.name||"匯入") + "（匯入）", created:Date.now()};
  await put("sessions", s);
  const srcMap = {};
  for (const src of m.sources || []) {
    const d = z[src.file]; if (!d) continue;
    const nid = "src" + Date.now().toString(36) + Math.random().toString(36).slice(2,6); srcMap[src.id] = nid;
    await put("sources", {id:nid, sid, name:src.name, type:src.type, blob:new Blob([d], {type:src.type || mimeOf(src.name)})});
  }
  for (const t of s.takes || []) { const d = z[`完整錄音/${t.id}.${t.ext || "webm"}`]; if (d) await put("master", {id:t.id + ":000000", sid, take:t.id, i:0, blob:new Blob([d], {type:t.mime || mimeOf("x." + (t.ext || "webm"))})}); else t.bytes = 0; t.driveId = null; }
  await put("sessions", s);
  for (const r of m.segments || []) {
    const g = normalize({...r, sid, id:sid + ":" + String(r.seq).padStart(5,"0")});
    g.blob = r.audioFile && z[r.audioFile] ? new Blob([z[r.audioFile]], {type:mimeOf(r.audioFile)}) : null;
    g.srcId = r.srcId ? (srcMap[r.srcId] || null) : null;
    delete g.audioFile;
    if (g.status==="transcribing") g.status = "queued"; if (g.status==="fixing") g.status = "transcribed";
    await put("segs", g);
  }
  sessions.unshift(s); await switchSession(sid);
  toast(`已匯入 ${(m.segments||[]).length} 段`); storageInfo();
}
$("#zipOut").onclick = exportZip; $("#menuZip").onclick = exportZip; $("#zipOut2").onclick = exportZip;
$("#zipIn").onchange = async e => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; if (rec.on) return toast("請先停止錄音"); try { await importZip(f); } catch(err){ toast("匯入失敗：" + err.message); } };

/* ================= 儲存空間 ================= */
async function storageInfo(){
  try {
    const e = await navigator.storage?.estimate?.(); const p = await navigator.storage?.persisted?.();
    $("#stInfo").textContent = (e ? `已用 ${MB(e.usage||0)}，瀏覽器允許約 ${MB(e.quota||0)}。` : "") + (p ? "已設為永久保存。" : "尚未永久保存：空間不足時瀏覽器可能清除資料。");
    $("#persistBtn").hidden = !!p;
  } catch { $("#stInfo").textContent = "無法讀取儲存空間資訊。"; }
}
$("#persistBtn").onclick = async () => { let ok = false; try { ok = await navigator.storage?.persist?.(); } catch {} toast(ok ? "已設為永久保存" : "瀏覽器沒有同意。請把本頁加入主畫面或書籤後再試。"); storageInfo(); };
function delAudioHandler(){
  const n = [...segs.values()].filter(g => g.blob && g.driveAudioId).length;
  if (!n) return toast("沒有已備份到 Google Drive 的音檔。只有備份到 Drive 的音檔才能從本機刪除。");
  $("#delAudioWrap").innerHTML = `<span class="confirm">從這台裝置刪除 ${n} 段已備份到 Drive 的音檔？之後播放或重辨識會從 Drive 讀取。<button class="danger" id="yesDA" type="button">確定刪除</button><button id="noDA" type="button">取消</button></span>`;
  $("#noDA").onclick = resetDA;
  $("#yesDA").onclick = async () => { for (const g of segs.values()) if (g.blob && g.driveAudioId) { g.blob = null; touch(g); await saveSeg(g, true); } resetDA(); render(); storageInfo(); driveUI(); toast(`已釋放 ${n} 段音檔`); };
}
function resetDA(){ $("#delAudioWrap").innerHTML = '<button id="delAudio" class="danger" type="button">釋放本機空間</button>'; $("#delAudio").onclick = delAudioHandler; }
$("#delAudio").onclick = delAudioHandler;

