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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;

const langLabelMap = {
  "zh-TW": "繁體中文",
  "en": "英文",
  "id": "印尼文",
  "ja": "日文",
  "ko": "韓文"
};

const flagMap = {
  "zh-TW": "🇹🇼",
  "en": "🇺🇸",
  "id": "🇮🇩",
  "ja": "🇯🇵",
  "ko": "🇰🇷"
};

// ✅ Gemini 翻譯處理
async function translateWithGemini(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;
  const prompt = `
請幫我進行以下任務：

1. 判斷這段文字的語言（例如：英文、繁體中文、印尼文）
2. 將這段話翻譯為「繁體中文」與「英文」
3. 回覆格式請用 JSON，格式如下：

{
  "input_language": "印尼文",
  "original_text": "你給的原文",
  "zh_tw": "繁體中文翻譯",
  "en": "英文翻譯"
}

請直接輸出 JSON，不要多餘說明。

原文如下：
${text}
`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }]
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const result = await res.json();
  const raw = result.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!raw) throw new Error("Gemini 無回應");

  const match = raw.match(/{[\s\S]*}/);
  if (!match) throw new Error("Gemini 格式錯誤");

  return JSON.parse(match[0]);
}

// ✅ Fallback：Google Translate 處理
async function translateWithGoogle(text, targets) {
  const headers = { "Content-Type": "application/json" };
  const translations = [];

  // 偵測原始語言
  const detectRes = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_API_KEY}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ q: text, target: "en", format: "text" })
  });
  const detectData = await detectRes.json();
  const sourceLang = detectData.data.translations[0].detectedSourceLanguage;

  const filteredTargets = targets.filter(lang => lang !== sourceLang);

  for (const target of filteredTargets) {
    const transRes = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_API_KEY}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ q: text, target, format: "text", source: sourceLang })
    });
    const transData = await transRes.json();

    translations.push({
      lang: target,
      text: transData.data.translations[0].translatedText
    });
  }

  return {
    input_language: langLabelMap[sourceLang] || `語言代碼：${sourceLang}`,
    original_text: text,
    zh_tw: translations.find(t => t.lang === "zh-TW")?.text || "(略過)",
    en: translations.find(t => t.lang === "en")?.text || "(略過)"
  };
}

// ✅ 處理 LINE webhook event
app.post("/webhook", (req, res) => {
  res.status(200).send("OK");
  if (!req.body.events || req.body.events.length === 0) return;

  Promise.all(req.body.events.map(handleEvent))
    .catch(err => console.error("Event error:", err));
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  let result;

  try {
    result = await translateWithGemini(text);
  } catch (e) {
    console.warn("⚠️ Gemini 錯誤，啟用 Google fallback:", e.message);
    result = await translateWithGoogle(text, ["zh-TW", "en"]);
  }

  const reply =
    `🈸 你輸入的是：${result.input_language}\n` +
    `📖 原文：${result.original_text}\n\n` +
    `🇹🇼 繁體中文：\n${result.zh_tw}\n\n` +
    `🇺🇸 英文：\n${result.en}`;

  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: reply
  });
}

app.get("/", (req, res) => {
  res.send("✅ Gemini 翻譯機器人正在運作中");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
