import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import { franc } from "franc";
import fetch from "node-fetch";

const app = express();

// ✅ LINE middleware 放在 JSON parser 之前
app.use(middleware({
  channelSecret: process.env.LINE_CHANNEL_SECRET
}));

// ✅ 其他 API JSON parser 放後面
app.use(express.json());

const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

// ✅ 翻譯函式
async function translateWithGoogle(text, sourceLang, targetLangs) {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  const results = [];

  for (const target of targetLangs) {
    const bodyData = {
      q: text,
      target: target,
      format: "text"
    };
    if (sourceLang !== "auto") {
      bodyData.source = sourceLang;
    }

    const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${apiKey}`, {
      method: "POST",
      body: JSON.stringify(bodyData),
      headers: { "Content-Type": "application/json" }
    });

    const data = await res.json();

    if (!data.data || !data.data.translations) {
      console.error("❌ Google Translate API response error:", JSON.stringify(data));
      throw new Error("Google Translate 回應無效，無法取得翻譯結果");
    }

    results.push({
      lang: target,
      text: data.data.translations[0].translatedText
    });
  }

  return results;
}

// ✅ webhook 處理
app.post("/webhook", (req, res) => {
  res.status(200).send("OK");
  if (!req.body.events || req.body.events.length === 0) return;
  Promise.all(req.body.events.map(handleEvent))
    .catch(err => console.error("Event handling error:", err));
});

// ✅ 單則訊息處理
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  let langCode = franc(text);

  if (langCode === "und") {
    langCode = "en";
  }

  const langMap = {
    cmn: "zh-TW",
    zho: "zh-TW",
    eng: "en",
    enm: "en",
    ind: "id",
    jpn: "ja"
  };

  const source = langMap[langCode] || "auto";

  // ✅ 固定三語，但排除原文語言
  const allTargets = ["zh-TW", "en", "id"];
  const targets = allTargets.filter(lang => lang !== source);

  try {
    const translations = await translateWithGoogle(text, source, targets);
    const flagMap = {
      "en": "🇺🇸",
      "zh-TW": "🇹🇼",
      "id": "🇮🇩"
    };

    const replyText =
      `🌐 原文：\n${text}\n\n` +
      translations
        .map(t => `${flagMap[t.lang] || "🌍"} ${t.lang.toUpperCase()}：\n${t.text}`)
        .join("\n\n");

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: replyText
    });
  } catch (error) {
    console.error("Google Translate error:", error.message);
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "⚠️ 抱歉，翻譯時發生錯誤，請稍後再試。"
    });
  }
}

// ✅ 健康檢查
app.get("/", (req, res) => {
  res.send("✅ LINE Google Translate bot is running.");
});

// ✅ 啟動伺服器
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server is listening on port ${port}`);
});
