import "dotenv/config";
import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

// --- 關鍵：環境變數檢查 ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

if (!GEMINI_API_KEY || !lineConfig.channelAccessToken) {
  console.warn("⚠️ 警告：環境變數尚未設定完成！部署可能會成功但無法正常運作。");
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "dummy_key");
const lineClient = new Client(lineConfig);

// 翻譯參數
const targetLangs = ["zh-TW", "en", "id"];
const flagMap = { "zh-TW": "🇹🇼", "en": "🇺🇸", "id": "🇮🇩" };

async function translateWithGemini(text) {
  try {
    // 先改用最穩定的 1.5-flash 來確認部署是否能綠燈
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: "Translate to Traditional Chinese, English, Indonesian. Return raw JSON only.",
      generationConfig: { responseMimeType: "application/json" }
    });

    const result = await model.generateContent(text);
    const data = JSON.parse(result.response.text());
    return { success: true, translations: data.translations };
  } catch (e) {
    console.error("Gemini Error:", e.message);
    return { success: false };
  }
}

// Webhook 處理
app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  res.status(200).send("OK");
  req.body.events.forEach(async (event) => {
    if (event.type !== "message" || event.message.type !== "text") return;
    
    const text = event.message.text.trim();
    const result = await translateWithGemini(text);
    
    if (result.success) {
      const reply = targetLangs
        .map(l => `${flagMap[l]} ${result.translations[l]}`)
        .join("\n\n");
      lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
    }
  });
});

app.get("/", (req, res) => res.send("✅ Bot is online."));

// --- 關鍵：Cloud Run 啟動設定 ---
const PORT = process.env.PORT || 8080;
// 務必加上 "0.0.0.0"，否則 Cloud Run 會找不到你的 Port
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
