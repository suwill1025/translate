import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();

const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;

const targetLangs = ["zh-TW", "en", "id"];
const flagMap = {
  "zh-TW": "🇹🇼",
  "en": "🇺🇸",
  "id": "🇮🇩"
};

async function translateWithGemini(text) {
  const prompt = `
將下列句子分別翻譯成三種語言：繁體中文 (zh-TW)、英文 (en)、印尼文 (id)。
請只回傳以下 JSON 格式：
{
  "zh-TW": "...",
  "en": "...",
  "id": "..."
}

句子：${text}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    }
  );

  const data = await res.json();
  console.dir(data, { depth: null }); // 🔍 方便除錯

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error("Gemini 回應錯誤");

  const jsonMatch = raw.match(/{[\s\S]*}/);
  if (!jsonMatch) throw new Error("Gemini 格式無法解析");

  return JSON.parse(jsonMatch[0]);
}

async function translateWithGoogle(text) {
  const headers = { "Content-Type": "application/json" };
  const detectRes = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_API_KEY}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ q: text, target: "en", format: "text" })
  });
  const detectData = await detectRes.json();
  const sourceLang = detectData.data.translations[0].detectedSourceLanguage;

  const outputs = {};
  for (const lang of targetLangs) {
    if (lang === sourceLang) continue;

    const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_API_KEY}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ q: text, target: lang, format: "text", source: sourceLang })
    });

    const data = await res.json();
    outputs[lang] = data.data?.translations?.[0]?.translatedText || "(翻譯失敗)";
  }

  return outputs;
}

// ✅ 正確使用 middleware + raw bodyParser
app.post("/webhook",
  bodyParser.raw({ type: "*/*" }), // ⛔ 不能使用 express.json()！
  middleware({ channelSecret: process.env.LINE_CHANNEL_SECRET }),
  (req, res) => {
    res.status(200).send("OK");

    const events = req.body.events;
    if (!events || events.length === 0) return;

    Promise.all(events.map(handleEvent))
      .catch(err => console.error("Event error:", err));
  }
);

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  let translations = {};

  try {
    translations = await translateWithGemini(text);
  } catch (e) {
    console.warn("⚠️ Gemini 錯誤，啟用 Google fallback:", e.message);
    translations = await translateWithGoogle(text);
  }

  const replyLines = targetLangs
    .filter(lang => translations[lang])
    .map(lang => `${flagMap[lang] || "🌐"} ${translations[lang]}`)
    .join("\n\n");

  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: replyLines
  });
}

app.get("/", (req, res) => {
  res.send("✅ LINE 翻譯機器人正在運作中");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server listening on port ${port}`);
});
