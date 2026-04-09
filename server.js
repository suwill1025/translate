import "dotenv/config";
import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

const app = express();

// --- 設定區 ---
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const lineClient = new Client(lineConfig);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const targetLangs = ["zh-TW", "en", "id"];
const flagMap = { "zh-TW": "🇹🇼", "en": "🇺🇸", "id": "🇮🇩" };

const SYSTEM_INSTRUCTION = `Act as a native speaker of Traditional Chinese, English, and Indonesian. 
Translate the input into authentic, natural language. Return ONLY raw JSON:
{
  "detected_lang": "code",
  "translations": { "zh-TW": "...", "en": "...", "id": "..." }
}`;

// --- 核心翻譯邏輯 (Gemini) ---
async function translateWithGemini(text, retryCount = 2) {
  try {
    // 💡 建議先用 1.5-flash 或 2.0-flash，這在生產環境最穩
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash", 
      systemInstruction: SYSTEM_INSTRUCTION,
      generationConfig: { responseMimeType: "application/json" } // 🌟 強制 JSON 輸出
    });

    const result = await model.generateContent(text);
    const response = await result.response;
    
    // 安全過濾檢查
    if (response.candidates?.[0]?.finishReason === "SAFETY") throw new Error("SAFETY_BLOCKED");

    const data = JSON.parse(response.text());
    return { success: true, detectedLang: data.detected_lang, translations: data.translations };

  } catch (error) {
    // 💡 針對 503 (High Demand) 進行自動重試
    if (error.message.includes("503") || error.message.includes("demand")) {
      if (retryCount > 0) {
        console.warn(`🔄 伺服器忙碌，1秒後重試 (剩餘次數: ${retryCount})`);
        await new Promise(r => setTimeout(r, 1000));
        return translateWithGemini(text, retryCount - 1);
      }
    }
    console.error("❌ Gemini 錯誤:", error.message);
    return { success: false };
  }
}

// --- LINE 事件處理 ---
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const userInput = event.message.text.trim();

  // 1. 執行翻譯
  const result = await translateWithGemini(userInput);
  
  // 2. 如果 Gemini 失敗，可以在這裡補上你原本的 Google Translate 備援 (略)
  if (!result.success) return; 

  // 3. 過濾不需要的翻譯 (同語言不翻、錯誤不顯示)
  const replyLines = targetLangs
    .filter(lang => {
      const translated = result.translations[lang];
      if (!translated) return false;
      // 避免原文跟譯文一樣 (不分大小寫與空白)
      return translated.toLowerCase().replace(/\s/g, "") !== userInput.toLowerCase().replace(/\s/g, "");
    })
    .map(lang => `${flagMap[lang] || "🌐"} ${result.translations[lang]}`)
    .join("\n\n");

  if (!replyLines) return;

  return lineClient.replyMessage(event.replyToken, { type: "text", text: replyLines });
}

// --- Webhook 路由 ---
app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).send("OK"))
    .catch((err) => {
      console.error("Webhook Error:", err);
      res.status(500).end();
    });
});

app.get("/", (req, res) => res.send("✅ Bot is online."));

// --- 啟動伺服器 ---
const PORT = process.env.PORT || 8080; // Cloud Run 預設為 8080
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 翻譯機器人已在 Port ${PORT} 啟動`);
});
