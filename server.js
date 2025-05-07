import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import fetch from "node-fetch";

const app = express();

// ✅ LINE middleware 放 JSON parser 前面
app.use(middleware({
  channelSecret: process.env.LINE_CHANNEL_SECRET
}));

app.use(express.json());

const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

// ✅ 偵測語言 → 避免重複翻譯原文語言
async function translateWithGoogle(text, targetLangs) {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  const headers = { "Content-Type": "application/json" };

  // 先偵測語言
  const detectRes = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${apiKey}`, {
    method: "POST",
    body: JSON.stringify({
      q: text,
      target: "en",
      format: "text"
    }),
    headers
  });

  const detectData = await detectRes.json();
  const detectedLang = detectData.data.translations[0].detectedSourceLanguage;

  // 排除原文語言
  const filteredTargets = targetLangs.filter(lang => lang !== detectedLang);
  const translations = [];

  for (const target of filteredTargets) {
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${apiKey}`, {
      method: "POST",
      body: JSON.stringify({
        q: text,
        target,
        format: "text",
        source: detectedLang
      }),
      headers
    });

    const data = await res.json();

    if (!data.data || !data.data.translations) {
      throw new Error("Google Translate 回應異常");
    }

    translations.push({
      lang: target,
      text: data.data.translations[0].translatedText
    });
  }

  return { translations, sourceLang: detectedLang };
}

// ✅ Webhook handler
app.post("/webhook", (req, res) => {
  res.status(200).send("OK");
  if (!req.body.events || req.body.events.length === 0) return;

  Promise.all(req.body.events.map(handleEvent))
    .catch(err => console.error("Event error:", err));
});

// ✅ 語言代碼轉換對照表
const langLabelMap = {
  "en": "英文",
  "zh-TW": "繁體中文",
  "zh": "中文",
  "id": "印尼文",
  "ja": "日文",
  "ko": "韓文"
};

const flagMap = {
  "en": "🇺🇸",
  "zh-TW": "🇹🇼",
  "zh": "🇨🇳",
  "id": "🇮🇩",
  "ja": "🇯🇵",
  "ko": "🇰🇷"
};

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  const allTargets = ["zh-TW", "en", "id"];

  try {
    const { translations, sourceLang } = await translateWithGoogle(text, allTargets);
    const langLabel = langLabelMap[sourceLang] || `語言代碼：${sourceLang}`;
    const introLine = `🈸 你輸入的是：${langLabel}\n`;

    const translationLines = translations
      .map(t => `${flagMap[t.lang] || "🌍"} ${t.lang.toUpperCase()}：\n${t.text}`)
      .join("\n\n");

    const replyText = `${introLine}\n${translationLines}`;

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: replyText
    });
  } catch (error) {
    console.error("Google Translate error:", error.message);
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "⚠️ 翻譯錯誤，請稍後再試。"
    });
  }
}

app.get("/", (req, res) => {
  res.send("✅ LINE Google Translate bot is running.");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server is listening on port ${port}`);
});


