# Groq 連續聽寫 — 開發交接

給接手這個 repo 的 Claude 看的。使用者是 daouz（台灣），請用**台灣正體中文**回覆，介面文字也一律用台灣正體中文。

## 產品是什麼
單一網頁工具，無建置步驟，部署在 GitHub Pages：https://daouz.github.io/groq-dictation/ 。
主要在 **iPhone Safari** 使用，其次是電腦 Chrome。流程：連續錄音 → 自動分段 → Groq Whisper 轉錄 → gpt-oss 修正成台灣正體 → 人工審閱 → 整理成筆記。

## 程式結構
`index.html` 只有 HTML 骨架；樣式在 `css/app.css`，程式拆成 `js/` 下的經典 `<script>`（不是 ES module），**依檔名順序載入、共用同一個全域範圍**，所以任何檔案都能直接用其他檔案的函式與變數。
**改程式前先跑 `tools/outline.sh [檔名前綴]` 找到函式與行號，只讀需要的檔案，不要整批讀。**

| 檔案 | 內容與重點 |
|---|---|
| `00-core.js` | 工具（`$`、`esc`、`toast`、`LS`）；設定：`DEF` 預設值、`S` 設定物件（localStorage `gd_settings`）、`TIER()` 依免費／開發者方案決定併發數與每次送出量；提示橫幅 `banner()` |
| `10-store.js` | IndexedDB `groq-dictation` v4：`sessions`、`segs`（段落資料，不含音檔）、`segaudio`（段落音檔，key 同段落 id，只在錄好或換新時寫一次）、`sources`（上傳原檔）、`master`（完整母帶分塊）。**音檔一律以 ArrayBuffer 存入**，因為 Safari 存 Blob 重新整理後會 NotFoundError。段落一律經 `put("segs")`／`bySid("segs")`／`delKey("segs")` 存取，它們會一併處理 `segaudio`；`g._abFrom` 是「已存進 DB 的那個 Blob」，`g.blob` 被清掉且 `_abFrom` 有值才會刪音檔。v3 舊格式由 `migrateAudio()` 在開啟工作階段時逐段搬移。全域狀態 `segs`(Map)、`cur`、`normalize()`、`saveSeg()`、`needsReview()`；工作階段切換；`addSegment()` |
| `20-record.js` | 每段一個 MediaRecorder；`cut()` 先開新的、舊的晚 0.5 秒停（重疊防漏音）；`tick()` 每 50ms：最長秒數到了等 0.3 秒停頓才切、有聲 <0.6 秒不單獨成段；`noteGap()` 偵測中斷。`pauseRec/resumeRec`；Media Session 耳機按鍵（`hwArm()` 必須在按錄音鍵當下呼叫）；完整母帶 `masterStart/Stop`（每 5 秒寫入 `master`，`cur.takes` 記錄） |
| `30-audio.js` | `decodeTo16k`、`wav16`、`splitPCM`（上傳長檔依靜音切段，送出時才轉 16k WAV）、`segAudio()`、上傳檔案 |
| `40-asr.js` | `groq()`（429 解析 "try again in"）；`analyze()` 濾除片尾套語（`HALLU`）、重複、低信心、提示詞外洩；`sim()` 兩模型比對、`applyBest()`；逐段修正 `FIX_SYS`、`fixBatch()`、`parseFix()`（回傳 `{segments:[{seq,text,issues}]}`） |
| `50-queue.js` | `lanes.tx`／`lanes.fx` 兩條獨立佇列，`pump()` 排程；401 整體暫停；429 整條等待；轉錄額度用完時 `quotaFallback()` 改用 Apple 辨識暫代；`redo()`、`refix()` |
| `60-views.js` | 文字工具（`hlText`、`pushHist`）；統計、篩選、列表 `render()`／`reconcile()`（key 比對局部更新）；播放；逐段審閱：收合、時間軸 canvas、問題清單、閱讀模式、分章（時間／AI 主題）、排序 |
| `70-panel.js` | 審閱面板（右側，手機為底部抽屜）：播放、變速、問題逐條處理、兩模型對照、修改紀錄、面板頂／底再滑動切換上下段；全文尋找取代；合併稿 |
| `80-export.js` | 下載／複製、ZIP 匯出匯入（不壓縮）、儲存空間、釋放本機音檔 |
| `85-organize.js` | 整理全文：分塊 `ORG_PART` → 程式組合 → `ORG_SUM` 產生標題摘要；輸出含「待確認清單」並回寫到段落 |
| `90-webasr.js` | Apple／Web Speech API（zh-TW），錄音時同步；用「第一次聽到的時間」對應分段 |
| `95-drive.js` | Google Drive：GIS token client，scope `drive.file`，Client ID 寫死在程式內；token 每小時到期需使用者再按連線 |
| `99-boot.js` | 開 DB、載入工作階段、備份提醒。**所有「載入時就要執行、且會用到其他檔案函式」的程式放這裡** |

**拆檔後的規則：** 頂層程式在載入時只能呼叫「同檔或較前面檔案」的函式（函式提升不會跨檔）；放在事件處理函式裡的呼叫不受限。`tools/hoist-check.cjs` 會檢查。新增檔案要加到 `index.html` 的 script 清單並執行 `node tools/stamp.mjs`。

## 已確認的限制（不要再嘗試）
- iPhone 上「播放音檔給 Apple 辨識聽」不可行：開麥克風時 iOS 切成通話模式、聲音走聽筒且回音消除會濾掉。電腦版保留實驗按鈕，iOS 已隱藏。
- Claude 沒有可供網頁呼叫的語音轉文字。
- Groq Batch API 免費方案不能用。
- iPhone 錄 WebM 時 Safari 自己播不出來 → Safari／iOS 一律錄 MP4（`IS_WEBKIT`）。
- 網頁在背景或鎖屏時 iOS 會停麥克風，只能偵測並標示。

## 開發與驗證方式
- 改完執行 `tools/check.sh`：每個 js 做 `node --check`、載入順序檢查、版本號檢查，最後跑冒煙測試（`--fast` 可略過瀏覽器）。
- **改了 css／js 一定要執行 `node tools/stamp.mjs`** 更新 `index.html` 的 `?v=` 版本號，否則 iPhone 可能在 GitHub Pages 快取期間混用新舊檔案（`check.sh` 會擋下忘記更新的情況）。
- 儲存測試 `tools/store-test.mjs`：v3→v4 搬移、存檔不重寫音檔、釋放本機空間、ZIP 往返、刪除工作階段。改 `10-store.js` 必跑。
- 冒煙測試 `tools/smoke.mjs`：自帶靜態伺服器，以 iPhone 13 尺寸、模擬麥克風錄兩段 → 送轉錄（Groq 請求被攔截回 401）→ 暫停，並切換各檢視、開審閱面板；檢查無 pageerror、無左右捲動。`SHOTS=資料夾 tools/check.sh` 會存截圖。Playwright 在 `/opt/node22/lib/node_modules/playwright`，Chromium 在 `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`（可用環境變數 `PW`、`CHROME` 覆寫）。
- 手動測試：`python3 -m http.server 8765`。錄音流程可用 `--use-fake-device-for-media-stream` 模擬麥克風（記得在 `#key` 填值，`readForm()` 會讀輸入框）。
- 直接 commit 到 `main` 並 push，GitHub Pages 會自動更新。commit 訊息結尾附上系統要求的 attribution。

## 使用者偏好
- 直接動手做，做完簡短說明改了什麼、怎麼測；需要實機（iPhone）驗證的地方要明講。
- 重視錄音完整性與資料不遺失；音檔要能保存、備份（Drive、ZIP）。
- 幻聽很多，重視人工審閱效率。
- 免費 Groq 方案為主，注意 token 與額度。
- **開新主題提醒**：若對話拉得很長，且接下來的功能討論已經沒有延續性（話題跳來跳去、舊脈絡已不影響新決定），Claude 要主動提醒 daouz 開新主題，並先把目前的結論、已決定事項、未完成項目寫入本檔（對應段落更新，不另開新檔），方便新對話直接接續。

## 待辦（2026-10 程式檢視結果，依建議順序）
以下是讀程式碼得出的判斷，尚未實測：
1. ~~錄音偵測小修~~（2026-10 完成：`fftSize` 2048、有聲累計每次最多 0.25 秒、`tick()` 快取 DOM 並略過沒變的寫入）
2. ~~音檔與段落資料分開存~~（2026-10 完成：DB v4 `segaudio`，存檔不再重寫音檔，已在 Chromium 測過；iPhone 實機已確認：舊工作階段升級後能播放、新錄音重新整理後能播放；「釋放本機空間」使用者回報應該正常）。注意：v4 之後若要退回舊版程式，舊版開不了 v4 資料庫。尚未做的部分：切換工作階段仍會把該工作階段的音檔全部載入記憶體，可再改成需要時才讀。
3. ~~上傳長檔記憶體~~（2026-10 完成程式：`decodeTo16k` 改用 `new AudioContext({sampleRate:16000})` 直接以 16k 解碼，多聲道逐聲道累加成單聲道；不支援指定取樣率時退回離線降取樣。**iPhone 實機待確認**：上傳長檔能解碼、切段與轉錄正常。`pcmCache` 仍常駐一份 16k 單聲道 PCM，約 230 MB／小時，未改）
4. ~~錄音門檻統一~~（2026-10 完成程式：`tick()` 改用自適應雜訊底＋進出雙門檻，進入 = min(`S.thr`, max(0.003, 雜訊底×3))、離開 = 進入×0.6，與 `splitPCM` 同算法；`S.thr` 現在是上限。**需實錄測試**：安靜／嘈雜環境下自動切段時機、有聲秒數是否合理，音量條黃線仍是 `S.thr` 上限）
5. ~~接縫重複標記~~（2026-10 完成程式：`seamCheck()` 在修正完成後比對上一段結尾與本段開頭，相同 2–8 字就加一筆「疑似接縫重複」問題，建議刪除但需人工按；只對錄音段、未手動編輯者。只用單元邏輯驗證過，**需實錄確認**誤報率）
6. ~~記錄 `usage`~~（2026-10 完成記錄：`fixBatch` 每次把輸入／輸出／推理 tokens、批次段數、`finish_reason` 存進 localStorage `gd_usage`（最近 100 筆），設定的儲存空間區顯示平均與被截斷次數。**等 daouz 實際用一陣子後**，依數字決定是否調整 `TIER().batch`／`fixTok` 或精簡 `FIX_SYS`）
- 實機待驗證：AirPods 按鍵、Apple 同步辨識在 iPhone 上是否與錄音衝突、MP4 播放。
