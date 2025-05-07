require("dotenv").config();
const express = require("express");
const OpenAI = require("openai");
const { Client, middleware } = require("@line/bot-sdk");
const franc = require("franc");

const app = express();
app.use(express.json());
app.use(middleware({
  channelSecret: process.env.LINE_CHANNEL_SECRET
}));

const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ✅ 正確處理 webhook，先回 200，避免 LINE timeout
app.post("/webhook", (req, res) => {
  res.status(200).send("OK");

  if (!req.body.events || req.body.events.length === 0) return;

  Promise.all(req.body.events.map(handleEvent))
    .catch(err => console.error("Event handling error:", err));
});

// ✅ 包在 async function 中使用 await
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  const langCode = franc(text);

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
      text: "Sorry, I couldn't translate that due to an error."
    });
  }
}

// 顯示健康檢查訊息
app.get("/", (req, res) => {
  res.send("✅ LINE ChatGPT Translator is running.");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server is listening on port ${port}`);
});
