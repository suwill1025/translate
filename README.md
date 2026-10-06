# LINE 翻譯機器人 v5.0.0

將文字在繁體中文、英文與印尼文之間互譯，隱藏原文語言，保留原本的國旗標示。

## 本次更新

- 使用 Google 官方維護的 `@google/genai` SDK。
- 預設模型為 `gemini-3.5-flash-lite`，失敗時視錯誤種類退回 `gemini-2.5-flash`、`gemini-2.5-flash-lite`；移除已停用的 2.0 模型。
- 使用 JSON Schema 並再次驗證回傳欄位，統一來源語言代碼。
- 改善姓名、數字、否定、語氣、段落與台灣繁中的翻譯要求。
- 等待並捕捉 LINE 回覆失敗；不把原始 API 錯誤或訊息內容寫入使用者回覆或日誌。
- 每次模型請求最多 12 秒、最多三個模型嘗試；SDK 自動重試停用，避免重複重試。
- 在單一執行程序內去除最近 10 分鐘重複收到的事件。記憶會在 Render 重啟或休眠後重設。
- 長譯文拆成最多五則回覆；原文超過 3,000 字元時，提示使用者分段。

這一版仍只處理文字，不儲存對話記憶，也不新增付費資料庫或主機。

## Render 部署（維持 Free）

使用原本的 Render Web Service 與 Free compute plan，無須建立新服務。

1. GitHub repository：`suwill1025/translate`，branch：`main`。
2. Build Command：`npm ci`（原本的 `npm install` 也可使用）。
3. Start Command：`npm start`。
4. Node.js 使用 22.x，已在 `package.json` 設定。如果 Render 已另外設定 `NODE_VERSION`，請設為 `22`。
5. 保留原有三個必要環境變數：
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_CHANNEL_SECRET`
   - `GEMINI_API_KEY`
6. LINE webhook 繼續使用 `https://你的服務.onrender.com/webhook`。

沒有新的必要環境變數。可選的 `GEMINI_MODEL` 與 `GEMINI_FALLBACK_MODELS`（逗號分隔，空字串代表無備援）用於自行指定模型。

啟用 Render 自動部署時，更新 main 後會開始部署。否則點選 **Manual Deploy → Deploy latest commit**。不要更改 Free 方案。

## 確認更新與 LINE 測試

部署完成後，開啟 Render 服務首頁，應顯示 `LINE Translator v5.0.0 is Online.`。這只表示程式已啟動；仍需 LINE 實測確認金鑰、模型存取與 webhook。

接著在 LINE 各傳一則繁中、英文、印尼文，確認只回覆另外兩種語言。測試時間、金額、否定及人名，例如：

- 明天下午 3 點請先不要出門，等我通知。
- Please bring 2 bottles of water, not 3.
- Besok saya datang jam 10 pagi.

也可一次傳兩則短訊息，確認都有回覆。照片、語音與貼圖會忽略。

Render Free 閒置會休眠，第一則訊息可能受喚醒時間影響。如果第一則沒回，等服務啟動後再傳一次。這項 Free 限制不是本次程式更新能取消的。

## 本機測試

```sh
npm ci
npm test
```

測試用模擬的 Gemini 與 LINE 回覆，不需要真實金鑰、不會產生 API 費用。
