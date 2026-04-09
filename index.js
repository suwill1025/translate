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
      // 🌟 修正點：改用 2.0 穩定版 ID，解決 404 問題
      model: "gemini-2.0-flash", 
      systemInstruction: "Translate to Traditional Chinese, English, Indonesian. Return ONLY raw JSON.",
      generationConfig: { responseMimeType: "application/json" }
    });

    const result = await model.generateContent(text);
    const response = await result.response;
    const data = JSON.parse(response.text());
    return { success: true, translations: data.translations };

  } catch (error) {
    if (retryCount > 0 && (error.message.includes("503") || error.message.includes("429"))) {
      await new Promise(r => setTimeout(r, 1000));
      return translateWithGemini(text, retryCount - 1);
    }
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
      // 🌟 新增：如果翻譯失敗，直接在 LINE 報錯，方便你除錯
      lineClient.replyMessage(event.replyToken, { 
        type: "text", 
        text: `❌ 翻譯失敗\n原因: ${result.error}` 
      });
    }
  });
});

app.get("/", (req, res) => res.send("✅ Bot v2.0 is online."));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server starts on ${PORT}`);
});
