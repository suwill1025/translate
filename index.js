// VERSION: 2.8 (Gemini 2.5 穩定版)
import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// 使用清單上確認可用的 API Key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const lineClient = new Client(lineConfig);

async function translateWithGemini(text) {
  try {
    // 🌟 核心：使用你清單中最新且穩定的 2.5 版本
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: "You are a professional translator. Translate to Traditional Chinese, English, and Indonesian. Return ONLY valid JSON format with keys 'zh-TW', 'en', and 'id'.",
      generationConfig: { responseMimeType: "application/json" }
    });

    const result = await model.generateContent(text);
    const data = JSON.parse(result.response.text());
    
    return { success: true, translations: data };
  } catch (error) {
    console.error(`[v2.8 Error]: ${error.message}`);
    return { success: false, error: error.message };
  }
}

app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  res.status(200).send("OK");
  
  req.body.events.forEach(async (event) => {
    if (event.type !== "message" || event.message.type !== "text") return;
    
    const result = await translateWithGemini(event.message.text.trim());
    
    if (result.success) {
      const t = result.translations;
      const reply = `🇹🇼 ${t["zh-TW"]}\n\n🇺🇸 ${t["en"]}\n\n🇮🇩 ${t["id"]}`;
      lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
    } else {
      lineClient.replyMessage(event.replyToken, { 
        type: "text", 
        text: `❌ [v2.8] 系統錯誤\n請檢查 Cloud Run 日誌: ${result.error}` 
      });
    }
  });
});

app.get("/", (req, res) => res.send("✅ Version 2.8 is Online."));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 v2.8 Running on Port ${PORT}`);
});
