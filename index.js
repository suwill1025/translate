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
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "dummy_key");
const lineClient = new Client(lineConfig);

const targetLangs = ["zh-TW", "en", "id"];
const flagMap = { "zh-TW": "🇹🇼", "en": "🇺🇸", "id": "🇮🇩" };

async function translateWithGemini(text, retryCount = 1) {
  try {
    const model = genAI.getGenerativeModel({
      // 🌟 核心修正：升級至 2026 年最強模型 Gemini 3 Flash
      model: "gemini-3-flash", 
      systemInstruction: "You are an expert translator. Translate to Traditional Chinese, English, and Indonesian. Return ONLY raw JSON format.",
      generationConfig: { 
        responseMimeType: "application/json",
        temperature: 0.2 // 調低溫度讓翻譯更精準穩定
      }
    });

    const result = await model.generateContent(text);
    const response = await result.response;
    const data = JSON.parse(response.text());
    return { success: true, translations: data.translations };

  } catch (error) {
    console.error("Gemini 內部錯誤:", error.message);
    return { success: false, error: error.message };
  }
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
      // 報錯給開發者（你），方便檢查
      lineClient.replyMessage(event.replyToken, { 
        type: "text", 
        text: `❌ 翻譯引擎故障\n訊息: ${result.error}\n(請確認 API Key 是否支援 Gemini 3)` 
      });
    }
  });
});

app.get("/", (req, res) => res.send("🚀 Gemini 3 Translator is Running!"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server is live on port ${PORT}`);
});
