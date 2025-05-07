import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import { franc } from "franc";
import fetch from "node-fetch";

const app = express();

// ✅ LINE middleware 放在 json parser 之前
app.use(middleware({
  channelSecret: process.env.LINE_CHANNEL_SECRET
}));

// ✅ 其他 API 的 json parser 放後面
app.use(express.json());

const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

async function translateWithGoogle(text, sourceLang, targetLangs) {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  const results = [];

  for (const target of targetLangs) {
    const bodyData = {
      q: text,
      target: target,
      format: "text"
    };

    // ✅ 如果 sourceLang 是自動偵測，不加入 source 欄位
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
      throw new Error(`Google Translate 回應無效，無法取得翻譯結果`);
    }

    results.push({
      lang: target,
      text: data.data.translations[0].translatedText
    });
  }

  return results;
}

app.post("/webhook", (req, res) => {
  res.status(200).send("OK");

  if (!req.body.events || req.body.events.length === 0) {
    return;
  }

  Promise.all(req.body.events.map(handleEvent))
    .catch(err => console.error("Event handling error:", err));
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  let langCode = franc(text);

  if (langCode === "und") {
    langCode = "en"; // 預設英文
  }

  const langMap = {
    cmn: "zh",
    eng: "en",
    ind: "id"
  };

  const source = langMap[langCode] || "auto";
  let targets = [];

  if (source === "zh") targets = ["en", "id"];
  else if (source === "id") targets = ["zh", "en"];
  else targets = ["zh", "id"];

  try {
    const translations = await translateWithGoogle(text, source, targets);
    const replyText = translations.map(t => `🔤 ${t.lang.toUpperCase()}:\n${t.text}`).join("\n\n");

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

app.get("/", (req, res) => {
  res.send("✅ LINE Google Translate bot is running.");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server is listening on port ${port}`);
});
