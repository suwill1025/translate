import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { OpenAI } from "openai";
import { Client, middleware } from "@line/bot-sdk";
import franc from "franc";

const app = express();

// ✅ LINE middleware 放在 json parser 之前
app.use(middleware({
  channelSecret: process.env.LINE_CHANNEL_SECRET
}));

// ✅ 其他 JSON API 再 parse body
app.use(express.json());

const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/webhook", (req, res) => {
  // ✅ 一定要在最前面就回傳 200
  res.status(200).send("OK");

  // ✅ 空 events 不做事
  if (!req.body.events || req.body.events.length === 0) {
    return;
  }

  // ✅ 非同步處理 event，不影響回應
  Promise.all(req.body.events.map(handleEvent))
    .catch(err => console.error("Event handling error:", err));
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  let langCode = franc(text);

  // ✅ 若無法偵測語言，自動設為英文
  if (langCode === "und") {
    langCode = "eng";
  }

  let prompt = "";

  if (langCode === "cmn") {
    prompt = `請將這句中文翻譯為英文和印尼文：\n\n${text}`;
  } else if (langCode === "ind") {
    prompt = `Please translate this Indonesian sentence into Chinese and English:\n\n${text}`;
  } else {
    prompt = `Translate the following sentence into Chinese and Indonesian:\n\n${text}`;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5
    });

    const replyText = completion.choices[0].message.content;

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: replyText
    });
  } catch (error) {
    console.error("OpenAI error:", error.message);

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "⚠️ 抱歉，翻譯過程中發生錯誤（可能是語言無法辨識、API 錯誤或回覆過長）"
    });
  }
}

app.get("/", (req, res) => {
  res.send("✅ LINE ChatGPT Translator is running.");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server is listening on port ${port}`);
});
