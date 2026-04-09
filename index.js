import "dotenv/config";
import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 🌟 關鍵修正：強制指定使用 'v1' 正式版接口，避開 404 的 v1beta
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "", { apiVersion: "v1" });
const lineClient = new Client(lineConfig);

const targetLangs = ["zh-TW", "en", "id"];
const flagMap = { "zh-TW": "🇹🇼", "en": "🇺🇸", "id": "🇮🇩" };

async function translateWithGemini(text) {
  // 💡 定義 2026 年最穩定的正式版模型 ID 順序
  const modelCandidates = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-1.0-pro"];
  
  for (const modelName of modelCandidates) {
    try {
      console.log(`📡 嘗試連接穩定版模型: ${modelName}`);
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: "Act as a native translator for Traditional Chinese, English, and Indonesian. Return ONLY raw JSON.",
        generationConfig: { responseMimeType: "application/json" }
      });

      const result = await model.generateContent(text);
      const data = JSON.parse(result.response.text());
      return { success: true, translations: data.translations, usedModel: modelName };
    } catch (error) {
      if (error.message.includes("404")) {
        console.warn(`⚠️ 模型 ${modelName} 在 v1 接口中仍報 404，切換下一個...`);
        continue;
      }
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: "所有穩定版模型均無法存取，請檢查 API Key 專案權限" };
}

app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  res.status(200).send("OK");
  
  req.body.events.forEach(async (event) => {
    if (event.type !== "message" || event.message.type !== "text") return;
    
    const userInput = event.message.text.trim();
    const result = await translateWithGemini(userInput);
    
    if (result.success) {
      const reply = targetLangs
        .filter(l => result.translations[l])
        .map(l => `${flagMap[l]} ${result.translations[l]}`)
        .join("\n\n");
      lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
    } else {
      // 直接回報具體錯誤給 LINE，方便我們診斷
      lineClient.replyMessage(event.replyToken, { 
        type: "text", 
        text: `❌ 翻譯失敗 (v1 穩定版)\n原因: ${result.error}\n💡 建議確認 Google Cloud 專案是否已啟用 Gemini API` 
      });
    }
  });
});

app.get("/", (req, res) => res.send("✅ Translator v1-Stable is Live."));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server starts on ${PORT} using v1 API`);
});
