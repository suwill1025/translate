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
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "");
const lineClient = new Client(lineConfig);

const targetLangs = ["zh-TW", "en", "id"];
const flagMap = { "zh-TW": "🇹🇼", "en": "🇺🇸", "id": "🇮🇩" };

// 🌟 核心：自動尋找可用的模型
async function getBestModel() {
  const possibleModels = [
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash",
    "gemini-pro",
    "gemini-2.0-flash-exp"
  ];

  // 這裡我們直接試最穩的 1.5 系列
  return "gemini-1.5-flash-latest"; 
}

async function translateWithGemini(text) {
  try {
    const modelName = await getBestModel();
    console.log(`📡 正在使用模型: ${modelName}`);

    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: "You are a professional translator. Translate the input into Traditional Chinese, English, and Indonesian. Return ONLY raw JSON.",
      generationConfig: { responseMimeType: "application/json" }
    });

    const result = await model.generateContent(text);
    const data = JSON.parse(result.response.text());
    return { success: true, translations: data.translations };

  } catch (error) {
    console.error("❌ Gemini 執行失敗:", error.message);
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
      // 在 LINE 直接噴出錯誤原因，我們才好除錯
      lineClient.replyMessage(event.replyToken, { 
        type: "text", 
        text: `❌ 翻譯失敗\n原因: ${result.error}\n💡 請確認 Cloud Run 的版本號是否已更新。` 
      });
    }
  });
});

app.get("/", (req, res) => res.send("✅ Translator is Online."));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server on port ${PORT}`);
});
