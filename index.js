// VERSION: 4.1 (移除 dotenv 依賴，徹底解決啟動崩潰)
import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

// 🛡️ 啟動保護：雲端環境會自動讀取 process.env，若無則套用 DUMMY 防止崩潰
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "DUMMY_TOKEN",
  channelSecret: process.env.LINE_CHANNEL_SECRET || "DUMMY_SECRET"
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "DUMMY_KEY");
const lineClient = new Client(lineConfig);

const targetLangs = ["zh-TW", "en", "id"];
const flagMap = { "zh-TW": "🇹🇼", "en": "🇺🇸", "id": "🇮🇩" };

const SYSTEM_INSTRUCTION = `You are an expert translator. Translate the input into Traditional Chinese, English, and Indonesian. Return ONLY valid JSON in this exact format:
{"detected_lang": "zh-TW", "translations": { "zh-TW": "...", "en": "...", "id": "..." }}`;

async function translateWithGemini(text) {
  // 🌟 防塞車備援大腦
  const modelsToTry = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];

  for (let i = 0; i < modelsToTry.length; i++) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelsToTry[i],
        systemInstruction: SYSTEM_INSTRUCTION,
        generationConfig: { responseMimeType: "application/json" }
      });

      const result = await model.generateContent(text);
      const data = JSON.parse(result.response.text());
      return { success: true, data: data };

    } catch (error) {
      console.warn(`[嘗試 ${modelsToTry[i]} 失敗]: ${error.message}`);
      if ((error.message.includes("503") || error.message.includes("429")) && i < modelsToTry.length - 1) {
        continue;
      }
      if (i === modelsToTry.length - 1) {
        return { success: false, error: error.message };
      }
    }
  }
}

app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  res.status(200).send("OK");
  
  req.body.events.forEach(async (event) => {
    // 🛑 確保只處理純文字
    if (event.type !== "message" || event.message.type !== "text") return;
    
    if (lineConfig.channelAccessToken === "DUMMY_TOKEN") {
       console.error("❌ 警告：未讀取到 LINE 環境變數！");
       return; 
    }

    const textToTranslate = event.message.text.trim();
    if (!textToTranslate) return;

    try {
      const translateResult = await translateWithGemini(textToTranslate);
      
      if (translateResult && translateResult.success) {
        const { detected_lang, translations } = translateResult.data;
        const reply = targetLangs
          .filter(lang => lang !== detected_lang) // 隱藏來源語言
          .filter(lang => translations[lang])
          .map(lang => `${flagMap[lang]} ${translations[lang]}`)
          .join("\n\n");

        if (reply) lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
      } else if (translateResult) {
        let errorMsg = `❌ 翻譯伺服器目前滿載，請稍後再試！\n(系統細節: ${translateResult.error})`;
        lineClient.replyMessage(event.replyToken, { type: "text", text: errorMsg });
      }
    } catch (error) {
      console.error(`[系統錯誤]: ${error.message}`);
    }
  });
});

app.get("/", (req, res) => res.send("✅ v4.1 (Cloud Optimized Edition) is Online."));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 v4.1 Running on Port ${PORT}`);
});
