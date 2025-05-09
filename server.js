import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import fetch from "node-fetch";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

const app = express();
app.use(express.json()); // 先處理 JSON 再給指定 middleware

const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("錯誤：GEMINI_API_KEY 未設定！請檢查您的 .env 檔案。");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({
  model: "gemini-1.5-flash-latest",
  safetySettings: [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE }
  ]
});

const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
const targetLangs = ["zh-TW", "en", "id"];
const flagMap = {
  "zh-TW": "🇹🇼",
  "en": "🇺🇸",
  "id": "🇮🇩"
};

async function detectInputLanguage(text) {
  try {
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TRANSLATE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text })
    });
    const data = await res.json();
    return data.data.detections[0][0].language;
  } catch (e) {
    console.error("偵測輸入語言失敗：", e.message);
    return "auto";
  }
}

async function translateWithGemini(text, filteredTargets) {
  const prompt = `請將以下句子分別翻譯成這些語言：${filteredTargets.join("、")}。\n請嚴格依照以下 JSON 格式回傳，不要包含任何 JSON 以外的文字或 markdown 標記：\n{\n  "zh-TW": "...",\n  "en": "...",\n  "id": "..." \n}\n\n要翻譯的句子如下：\n${text}`;

  let rawResponseText = "";
  try {
    const chat = geminiModel.startChat();
    const result = await chat.sendMessage(prompt);
    const response = result.response;
    rawResponseText = response.text();

    let parsedJson;
    try {
      parsedJson = JSON.parse(rawResponseText);
    } catch (e) {
      const match = rawResponseText.match(/{[\s\S]*}/);
      if (match && match[0]) {
        parsedJson = JSON.parse(match[0]);
      } else {
        throw new Error("Gemini API 回傳格式錯誤或非 JSON: " + rawResponseText);
      }
    }

    const translations = {};
    for (const lang of filteredTargets) {
      if (parsedJson[lang] && typeof parsedJson[lang] === "string") {
        translations[lang] = parsedJson[lang];
      } else {
        translations[lang] = "(Gemini 翻譯失敗)";
      }
    }
    return translations;
  } catch (error) {
    console.error("Gemini 錯誤:", error.message);
    const fallback = {};
    for (const lang of filteredTargets) fallback[lang] = "(Gemini API 錯誤)";
    return fallback;
  }
}

async function translateWithGoogle(text, filteredTargets) {
  const headers = { "Content-Type": "application/json" };
  const outputs = {};

  for (const lang of filteredTargets) {
    try {
      const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_API_KEY}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ q: text, target: lang, format: "text" })
      });
      const data = await res.json();
      outputs[lang] = data.data?.translations?.[0]?.translatedText || "(Google 翻譯錯誤)";
    } catch (e) {
      outputs[lang] = "(Google API 呼叫失敗)";
    }
  }
  return outputs;
}

// ✅ 改為只有 /webhook 才套用 LINE middleware
app.post("/webhook",
  lineMiddleware({ channelSecret: process.env.LINE_CHANNEL_SECRET }),
  async (req, res) => {
    res.status(200).send("OK");
    if (!req.body.events || req.body.events.length === 0) return;

    for (const event of req.body.events) {
      if (event.type !== "message" || event.message.type !== "text") continue;
      const text = event.message.text.trim();
      const detectedLang = await detectInputLanguage(text);

      const langMap = { zh: "zh-TW", "zh-CN": "zh-TW", en: "en", id: "id" };
      const sourceLangMapped = langMap[detectedLang] || detectedLang;
      const filteredTargets = targetLangs.filter(lang => lang !== sourceLangMapped);

      console.log(`📨 收到訊息: "${text}" (${detectedLang}) → 翻譯為: ${filteredTargets.join(", ")}`);

      let translations = await translateWithGemini(text, filteredTargets);

      const geminiFailed = Object.values(translations).every(v => v.includes("失敗") || v.includes("錯誤"));
      if (geminiFailed) {
        console.warn("⚠️ Gemini 全部失敗，改用 Google fallback");
        translations = await translateWithGoogle(text, filteredTargets);
      }

      const replyLines = filteredTargets.map(lang => `${flagMap[lang] || "🌐"} ${translations[lang]}`).join("\n\n");

      await lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: replyLines || "⚠️ 無翻譯結果"
      });
    }
  }
);

// ✅ Render 健康檢查用
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ✅ 首頁測試路由（非必需，但方便 debug）
app.get("/", (req, res) => {
  res.send("✅ LINE 翻譯機器人 (Gemini + Google fallback) 正常運作中");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server listening on port ${port}`);
});
