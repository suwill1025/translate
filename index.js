// VERSION: 2.5 (這行是為了讓你在日誌裡辨識版本)
import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// 🌟 指定使用 v1 正式接口
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "", { apiVersion: "v1" });
const lineClient = new Client(lineConfig);

async function translateWithGemini(text) {
  try {
    // 💡 軒，我們就用你付費帳號最穩的 1.5-flash
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: "You are a professional translator. Translate to Traditional Chinese, English, and Indonesian. Return JSON.",
      generationConfig: { responseMimeType: "application/json" }
    });

    const result = await model.generateContent(text);
    const data = JSON.parse(result.response.text());
    return { success: true, translations: data.translations };
  } catch (error) {
    // 這裡會印出版本號，幫我們確認新代碼有沒有生效
    console.error(`[v2.5 Error]: ${error.message}`);
    return { success: false, error: error.message };
  }
}

app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  res.status(200).send("OK");
  req.body.events.forEach(async (event) => {
    if (event.type !== "message" || event.message.type !== "text") return;
    const result = await translateWithGemini(event.message.text.trim());
    if (result.success) {
      const reply = `🇹🇼 ${result.translations["zh-TW"]}\n\n🇺🇸 ${result.translations["en"]}\n\n🇮🇩 ${result.translations["id"]}`;
      lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
    } else {
      lineClient.replyMessage(event.replyToken, { 
        type: "text", 
        text: `❌ [v2.5] 翻譯失敗\n原因: ${result.error}` 
      });
    }
  });
});

app.get("/", (req, res) => res.send("✅ Version 2.5 is Online."));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 v2.5 Running on Port ${PORT}`);
});
