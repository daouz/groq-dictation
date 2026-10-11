"use strict";
/* ================= 啟動 ================= */
window.addEventListener("beforeunload", e => { if (rec.on || lanes.tx.busy.size || lanes.fx.busy.size) { e.preventDefault(); e.returnValue = ""; } });
openDB().then(d => { db = d; return loadSessions(); }).then(() => {
  setView(UI.view); storageInfo(); driveUI(); if (driveOn()) { drive.dirty.add(cur.id); driveSync(); }
  const last = cur && LS.get("lastExport_"+cur.id, 0), n = segs.size;
  const onDrive = [...segs.values()].some(g => g.driveAudioId) || !!cur?.driveFiles?.json;
  if (n >= 30 && !onDrive && Date.now() - (last||0) > 3*86400000) banner("backup", `這個工作階段有 ${n} 段，超過 3 天沒有備份。建議到「設定與保存」匯出 ZIP。`);
}).catch(e => toast("無法開啟本機儲存：" + e.message));
