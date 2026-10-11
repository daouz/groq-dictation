"use strict";
/* ================= 音訊處理（解碼、切段、WAV） ================= */
async function decodeTo16k(blob){
  const ab = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext; const ac = new AC();
  let dec;
  try { dec = await new Promise((res,rej) => { const p = ac.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); }); }
  finally { try { ac.close(); } catch {} }
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const oc = new OAC(1, Math.max(1, Math.ceil(dec.duration*16000)), 16000);
  const s = oc.createBufferSource(); s.buffer = dec; s.connect(oc.destination); s.start();
  return (await oc.startRendering()).getChannelData(0);
}
function wav16(f32, sr=16000){
  const n=f32.length, b=new ArrayBuffer(44+n*2), v=new DataView(b);
  const w=(o,s)=>{ for(let i=0;i<s.length;i++) v.setUint8(o+i, s.charCodeAt(i)); };
  w(0,"RIFF"); v.setUint32(4,36+n*2,true); w(8,"WAVE"); w(12,"fmt "); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true); w(36,"data"); v.setUint32(40,n*2,true);
  for (let i=0,o=44;i<n;i++,o+=2){ const s=Math.max(-1,Math.min(1,f32[i])); v.setInt16(o, s<0 ? s*0x8000 : s*0x7fff, true); }
  return new Blob([b], {type:"audio/wav"});
}
function splitPCM(pcm){
  const F=800, fps=20, n=Math.floor(pcm.length/F);
  const rms=new Float32Array(n);
  for (let i=0;i<n;i++){ let s=0; for (let j=i*F;j<(i+1)*F;j++) s+=pcm[j]*pcm[j]; rms[i]=Math.sqrt(s/F); }
  const sm=new Float32Array(n);
  for (let i=0;i<n;i++){ let s=0,c=0; for (let k=Math.max(0,i-3);k<=Math.min(n-1,i+3);k++){ s+=rms[k]; c++; } sm[i]=s/c; }
  const noise = [...rms].sort((a,b)=>a-b)[Math.floor(n*0.1)] || 0;
  const thr = Math.min(S.thr, Math.max(0.003, noise*3));
  const minF=Math.round(S.minSec*fps), maxF=Math.round(S.maxSec*fps), cuts=[];
  let pos=0;
  while (pos < n){
    let end;
    if (n-pos <= maxF) end = n;
    else { let best=pos+minF, bv=Infinity; for (let i=pos+minF; i<=pos+maxF && i<n; i++) if (sm[i] < bv){ bv=sm[i]; best=i; } end = best; }
    let v=0; for (let i=pos;i<end;i++) if (rms[i] > thr) v++;
    cuts.push({a:pos/fps, b:end/fps, voiced:v/fps}); pos=end;
  }
  if (!cuts.length) cuts.push({a:0, b:pcm.length/16000, voiced:0});
  return cuts;
}
let pcmCache = {id:null, p:null};
function getPCM(id){
  if (pcmCache.id !== id) {
    const p = (async () => { const s = await getOne("sources", id); if (!s) throw new Error("找不到原始音檔"); return decodeTo16k(s.blob || (s.driveId ? await driveBlob(s.driveId, s.type) : null) || (()=>{ throw new Error("原始音檔不在本機，請連線 Google Drive"); })()); })();
    pcmCache = {id, p};
    p.catch(() => { if (pcmCache.id===id) pcmCache = {id:null, p:null}; });
  }
  return pcmCache.p;
}
async function segAudio(g){
  if (g.blob) {
    const ext = g.ext || extOf(g.blob.type) || "webm";
    if (GROQ_OK.includes(ext)) return {blob:g.blob, ext};
    return {blob: wav16(await decodeTo16k(g.blob)), ext:"wav"};
  }
  if (g.srcId) {
    const pcm = await getPCM(g.srcId);
    return {blob: wav16(pcm.subarray(Math.floor((g.start||0)*16000), Math.min(pcm.length, Math.ceil((g.end||0)*16000)))), ext:"wav"};
  }
  if (g.driveAudioId) {
    const ext = g.ext || "webm", b = await driveBlob(g.driveAudioId, mimeOf("x." + ext));
    if (GROQ_OK.includes(ext)) return {blob:b, ext};
    return {blob: wav16(await decodeTo16k(b)), ext:"wav"};
  }
  throw Object.assign(new Error("這段沒有保存音檔"), {noAudio:true});
}
async function importAudioFile(f){
  toast("讀取 " + f.name + "…");
  let pcm;
  try { pcm = await decodeTo16k(f); }
  catch {
    const ext = extOf(f.type) || (f.name.split(".").pop()||"").toLowerCase();
    if (f.size <= 24.5*1048576 && GROQ_OK.includes(ext)) { await addSegment(f, {ext, src:"檔案："+f.name}); return; }
    throw new Error("瀏覽器無法解碼這個檔案");
  }
  const srcId = "src" + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  await put("sources", {id:srcId, sid:cur.id, name:f.name, type:f.type, size:f.size, blob:f});
  pcmCache = {id:srcId, p:Promise.resolve(pcm)};
  const cuts = splitPCM(pcm), base = Date.now();
  for (const c of cuts) await addSegment(null, {srcId, start:c.a, end:c.b, dur:c.b-c.a, offset:c.a, at:base + c.a*1000, src:"檔案："+f.name,
    ext:"wav", voiced:c.voiced, skip: c.voiced < 0.6 ? "（靜音）" : ""});
  toast(`${f.name}：切成 ${cuts.length} 段`);
}
$("#file").onchange = async e => {
  const files = [...e.target.files]; e.target.value = "";
  if (!cur) return;
  for (const f of files) { try { await importAudioFile(f); } catch(err){ toast(f.name + "：" + err.message); } }
  storageInfo();
};

