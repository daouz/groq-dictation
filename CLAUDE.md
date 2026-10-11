# Groq 連續聽寫 — 開發交接

給接手這個 repo 的 Claude 看的。使用者是 daouz（台灣），請用**台灣正體中文**回覆，介面文字也一律用台灣正體中文。

## 產品是什麼
單一網頁工具（`index.html`，約 2,500 行，無建置步驟），部署在 GitHub Pages：https://daouz.github.io/groq-dictation/ 。
主要在 **iPhone Safari** 使用，其次是電腦 Chrome。流程：連續錄音 → 自動分段 → Groq Whisper 轉錄 → gpt-oss 修正成台灣正體 → 人工審閱 → 整理成筆記。

## 程式結構（`index.html` 內以 `/* ===== 區塊名 ===== */` 分段）
| 區塊 | 重點 |
|---|---|
| 設定 | `DEF` 預設值、`S` 設定物件（存在 localStorage `gd_settings`）、`TIER()` 依免費／開發者方案決定併發數與每次送出量 |
| IndexedDB | DB `groq-dictation` v3：`sessions`、`segs`、`sources`（上傳原檔）、`master`（完整母帶分塊）。**音檔一律以 ArrayBuffer 存入**（`put()`/`hydrate()`），因為 Safari 存 Blob 重新整理後會 NotFoundError |
| 錄音與自動切段 | 每段一個 MediaRecorder；`cut()` 先開新的、舊的晚 0.5 秒停（重疊防漏音）；最長秒數到了會等 0.3 秒停頓才切；有聲 <0.6 秒不單獨成段；`noteGap()` 偵測背景／麥克風被佔用造成的中斷 |
| 暫停、耳機按鍵 | `pauseRec/resumeRec`；Media Session（AirPods 按一下暫停／繼續、按兩下切段），需在按錄音鍵時 `hwArm()` 播放靜音音檔取得控制權 |
| 完整母帶 | `masterStart/Stop`，另一個 MediaRecorder 每 5 秒寫入 `master` store；`cur.takes` 記錄每次錄音 |
| 音訊處理 | `decodeTo16k`、`wav16`、`splitPCM`（上傳長檔依靜音切段，送出時才轉 16k WAV） |
| Groq API | `groq()`；429 解析 "try again in" 等待時間 |
| 轉錄與幻聽偵測 | `verbose_json`；`analyze()` 濾除片尾套語（`HALLU`）、重複、低信心、提示詞外洩；可疑段落自動換另一個 Whisper 模型並用 `sim()` 比對 |
| 逐段修正 | `FIX_SYS` 提示詞，批次送多段，回傳 JSON `{segments:[{seq,text,issues}]}` |
| 工作佇列 | `lanes.tx`／`lanes.fx` 兩條獨立佇列；401 整體暫停；429 整條等待；轉錄額度用完時 `quotaFallback()` 改用 Apple 辨識暫代 |
| 逐段審閱 | 收合沒問題的段落、時間軸 canvas、問題清單（以問題為單位）、閱讀模式、分章（時間／AI 主題）、排序 |
| 審閱面板 | 右側（手機為底部抽屜）；播放、變速、問題逐條處理、兩模型對照、修改紀錄；面板頂／底再滑動切換上下段 |
| 整理全文 | 分塊 `ORG_PART` → 程式組合 → `ORG_SUM` 產生標題摘要；輸出含「待確認清單」並回寫到段落 |
| Apple 辨識 | Web Speech API（zh-TW），錄音時同步；用「第一次聽到的時間」對應分段 |
| Google Drive | GIS token client，scope `drive.file`，Client ID 寫死在程式內；token 每小時到期需使用者再按連線 |

## 已確認的限制（不要再嘗試）
- iPhone 上「播放音檔給 Apple 辨識聽」不可行：開麥克風時 iOS 切成通話模式、聲音走聽筒且回音消除會濾掉。電腦版保留實驗按鈕，iOS 已隱藏。
- Claude 沒有可供網頁呼叫的語音轉文字。
- Groq Batch API 免費方案不能用。
- iPhone 錄 WebM 時 Safari 自己播不出來 → Safari／iOS 一律錄 MP4（`IS_WEBKIT`）。
- 網頁在背景或鎖屏時 iOS 會停麥克風，只能偵測並標示。

## 開發與驗證方式
- 只改 `index.html`；改完用 `node --check` 檢查抽出的 `<script>`。
- 介面用 Playwright（`/home/claude/.npm-global/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs`，Chromium 在 `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`）以 iPhone 13 尺寸截圖，檢查無左右捲動、無 pageerror。
- 錄音流程可用 `--use-fake-device-for-media-stream` 模擬麥克風測試（記得在 `#key` 填值，`readForm()` 會讀輸入框）。
- 本地伺服器：`python3 -m http.server 8765`。
- 直接 commit 到 `main` 並 push，GitHub Pages 會自動更新。commit 訊息結尾附上系統要求的 attribution。

## 使用者偏好
- 直接動手做，做完簡短說明改了什麼、怎麼測；需要實機（iPhone）驗證的地方要明講。
- 重視錄音完整性與資料不遺失；音檔要能保存、備份（Drive、ZIP）。
- 幻聽很多，重視人工審閱效率。
- 免費 Groq 方案為主，注意 token 與額度。

## 可能的後續工作
- 把 `index.html` 拆成多個檔案（CSS、錄音、Groq、審閱、Drive），之後每次修改只需讀相關檔案，更省 token。
- 實機待驗證：AirPods 按鍵、Apple 同步辨識在 iPhone 上是否與錄音衝突、MP4 播放。
