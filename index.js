import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

// 從環境變數抓取，如果抓不到，這裡會報錯
const API_KEY = process.env.GEMINI_API_KEY;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const genAI = new GoogleGenerativeAI(API_KEY || "");
const lineClient = new Client({ channelAccessToken: CHANNEL_ACCESS_TOKEN, channelSecret: CHANNEL_SECRET });

app.post("/webhook", lineMiddleware({ channelSecret: CHANNEL_SECRET }), async (req, res) => {
  res.status(200).send("OK");
  
  if (!API_KEY) {
    console.error("❌ 找不到 GEMINI_API_KEY，請檢查 Cloud Run 設定！");
    return;
  }

  for (const event of req.body.events) {
    if (event.type === "message" && event.message.type === "text") {
      try {
        // 直接硬寫一個最不可能錯的模型名稱
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(`將此段文字翻譯成繁體中文、英文、印尼文並以JSON格式回傳: "${event.message.text}"`);
        const textResponse = await result.response.text();
        
        lineClient.replyMessage(event.replyToken, { type: "text", text: `✅ 翻譯成功：\n${textResponse}` });
      } catch (err) {
        lineClient.replyMessage(event.replyToken, { type: "text", text: `❌ [v2.7] 錯誤：${err.message}` });
      }
    }
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 v2.7 Live`));
