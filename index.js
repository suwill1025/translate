import "dotenv/config";
import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

// --- 環境變數讀取 ---
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 初始化 LINE 與 Gemini
const lineClient = new Client(lineConfig);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "dummy_key");

const targetLangs = ["zh-TW", "en", "id"];
const flagMap = { "zh-TW": "🇹🇼", "en": "🇺🇸", "id": "🇮🇩" };

const SYSTEM_INSTRUCTION = `Act as a native speaker of Traditional Chinese, English, and Indonesian. 
Translate the input into authentic, natural, and culturally appropriate language for each target. 
Avoid literal machine translation. 

Return ONLY raw JSON:
{
  "detected_lang": "detected language code",
  "translations": {
    "zh-TW": "Natural Traditional Chinese",
    "en": "Natural English",
    "id": "Natural Indonesian"
  }
}`;

// --- 核心翻譯邏輯 ---
async function translateWithGemini(text, retryCount = 2) {
  try {
    const model = genAI.getGenerativeModel({
      // ✅ 使用 2026 穩定版 ID
      model: "gemini-2.0-flash", 
      systemInstruction: SYSTEM_INSTRUCTION,
      generationConfig: { 
        responseMimeType: "application/json",
        temperature: 0.3
      }
    });

    const result = await model.generateContent(text);
    const response = await result.response;
    
    // 安全過濾檢查
    if (response.candidates?.[0]?.finishReason === "SAFETY") {
      return { success: false, error: "SAFETY" };
    }

    const parsedData = JSON.parse(response.text());
    return { success: true, translations: parsedData.translations };

  } catch (error) {
    // 針對 503 忙碌或 429 限流進行重試
    if ((error.message.includes("503") || error.message.includes("429")) && retryCount > 0) {
      console.warn(`🔄 伺服器忙碌，1秒後重試...`);
      await new Promise(r => setTimeout(r, 1000));
      return translateWithGemini(text, retryCount - 1);
    }
    console.error("❌ Gemini API 錯誤:", error.message);
    return { success: false, error: error.message };
  }
}

// --- Webhook 路由 ---
app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  res.status(200).send("OK");
  
  req.body.events.forEach(async (event) => {
    if (event.type !== "message" || event.message.type !== "text") return;

    const userInput = event.message.text.trim();
    console.log(`📨 收到訊息: ${userInput}`);

    const result = await translateWithGemini(userInput);

    if (result.success) {
      const replyLines = targetLangs
        .filter(lang => {
          const t = result.translations[lang];
          // 過濾掉跟原文一樣的結果，避免重複
          return t && t.toLowerCase().replace(/\s/g, "") !== userInput.toLowerCase().replace(/\s/g, "");
        })
        .map(lang => `${flagMap[lang]} ${result.translations[lang]}`)
        .join("\n\n");

      if (replyLines) {
        lineClient.replyMessage(event.replyToken, { type: "text", text: replyLines });
      }
    } else {
      console.error("翻譯失敗，不予回覆");
    }
  });
});

app.get("/", (req, res) => res.send("✅ 翻譯機器人 (Gemini 2.0 版) 運作中"));

// --- 啟動設定 ---
const PORT = process.env.PORT || 8080;
// 💡 必須監聽 0.0.0.0 才能讓 Cloud Run 正常接收流量
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 伺服器已啟動於 Port ${PORT}`);
});
