// VERSION: 2.9.2 (防塞車 + 隱藏原文 + 防啟動崩潰版)
import "dotenv/config";
import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

// 🛡️ 啟動保護：加入 DUMMY 字串，避免啟動瞬間因為抓不到變數而崩潰，導致 8080 Port 報錯
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "DUMMY_TOKEN",
  channelSecret: process.env.LINE_CHANNEL_SECRET || "DUMMY_SECRET"
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "DUMMY_KEY");
const lineClient = new Client(lineConfig);

const targetLangs = ["zh-TW", "en", "id"];
const flagMap = { "zh-TW": "🇹🇼", "en": "🇺🇸", "id": "🇮🇩" };

async function translateWithGemini(text) {
  // 🌟 備用大腦清單：遇到 503 塞車自動切換
  const modelsToTry = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];

  for (let i = 0; i < modelsToTry.length; i++) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelsToTry[i],
        systemInstruction: "You are an expert translator. Translate the input into Traditional Chinese, English, and Indonesian. Return ONLY valid JSON in this exact format:\n{\"detected_lang\": \"zh-TW\", \"translations\": { \"zh-TW\": \"...\", \"en\": \"...\", \"id\": \"...\" }}",
        generationConfig: { responseMimeType: "application/json" }
      });

      const result = await model.generateContent(text);
      const data = JSON.parse(result.response.text());
      return { success: true, data: data };

    } catch (error) {
      console.warn(`[嘗試 ${modelsToTry[i]} 失敗]: ${error.message}`);
      // 若是塞車 (503) 且還有下一個模型，就繼續試
      if ((error.message.includes("503") || error.message.includes("429")) && i < modelsToTry.length - 1) {
        continue;
      }
      // 真的全塞車或發生其他錯誤才放棄
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
    
    // 如果是 DUMMY 保護狀態，直接報錯給使用者，但不讓伺服器死當
    if (lineConfig.channelAccessToken === "DUMMY_TOKEN") {
       console.error("❌ 警告：未讀取到環境變數！");
       return; 
    }

    const result = await translateWithGemini(event.message.text.trim());
    
    if (result.success) {
      const { detected_lang, translations } = result.data;
      
      const reply = targetLangs
        .filter(lang => lang !== detected_lang) // 隱藏來源語言
        .filter(lang => translations[lang])
        .map(lang => `${flagMap[lang]} ${translations[lang]}`)
        .join("\n\n");

      lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
    } else {
      let errorMsg = `❌ 翻譯伺服器目前滿載，請稍後再試！\n(系統細節: ${result.error})`;
      lineClient.replyMessage(event.replyToken, { type: "text", text: errorMsg });
    }
  });
});

app.get("/", (req, res) => res.send("✅ v2.9.2 (Safe Init) is Online."));

const PORT = process.env.PORT || 8080;
// 確保監聽 0.0.0.0
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 v2.9.2 Running on Port ${PORT}`);
});
