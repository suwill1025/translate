// VERSION: 2.9.1 (防塞車智慧隱藏版)
import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const lineClient = new Client(lineConfig);

const targetLangs = ["zh-TW", "en", "id"];
const flagMap = { "zh-TW": "🇹🇼", "en": "🇺🇸", "id": "🇮🇩" };

async function translateWithGemini(text) {
  // 🌟 核心升級：建立「備用大腦」清單。如果第一個塞車，一秒內自動換下一個！
  const modelsToTry = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];

  for (let i = 0; i < modelsToTry.length; i++) {
    const currentModelName = modelsToTry[i];
    try {
      console.log(`📡 嘗試連線至: ${currentModelName}`);
      const model = genAI.getGenerativeModel({
        model: currentModelName,
        systemInstruction: `You are an expert translator. Translate the input into Traditional Chinese, English, and Indonesian. 
        Return ONLY valid JSON in this exact format:
        {
          "detected_lang": "zh-TW", // or "en", "id"
          "translations": { "zh-TW": "...", "en": "...", "id": "..." }
        }`,
        generationConfig: { responseMimeType: "application/json" }
      });

      const result = await model.generateContent(text);
      const data = JSON.parse(result.response.text());
      
      return { success: true, data: data, usedModel: currentModelName };

    } catch (error) {
      console.warn(`⚠️ [${currentModelName} 報錯]: ${error.message}`);
      
      // 如果遇到 503 (塞車) 或 429 (限流)，且還有備用模型，就繼續試下一個
      if ((error.message.includes("503") || error.message.includes("429")) && i < modelsToTry.length - 1) {
        continue; 
      }
      // 如果不是塞車問題，或是連三個備用大腦都塞車，才回報錯誤
      if (i === modelsToTry.length - 1) {
        return { success: false, error: error.message };
      }
    }
  }
}

app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  res.status(200).send("OK");
  
  req.body.events.forEach(async (event) => {
    if (event.type !== "message" || event.message.type !== "text") return;
    
    const result = await translateWithGemini(event.message.text.trim());
    
    if (result.success) {
      const { detected_lang, translations } = result.data;
      
      // 自動隱藏輸入語言，只顯示目標語言
      const reply = targetLangs
        .filter(lang => lang !== detected_lang)
        .filter(lang => translations[lang])
        .map(lang => `${flagMap[lang]} ${translations[lang]}`)
        .join("\n\n");

      lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
    } else {
      // 萬一真的全部大塞車，給使用者一個友善的提示
      let errorMsg = `❌ 翻譯伺服器目前大塞車，請稍後再試！\n(系統細節: ${result.error})`;
      lineClient.replyMessage(event.replyToken, { type: "text", text: errorMsg });
    }
  });
});

app.get("/", (req, res) => res.send("✅ v2.9.1 (Anti-Traffic Jam) is Online."));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 v2.9.1 Running`);
});
