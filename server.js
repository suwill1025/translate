import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import fetch from "node-fetch";
import cron from "node-cron";
import { franc } from "franc";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

const app = express();

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

async function translateWithGeminiSmart(text, filteredTargets) {
  const langCode = franc(text);
  const langLabelMap = {
    ind: "Bahasa Indonesia",
    jav: "Javanese（爪哇語）",
    sun: "Sundanese（巽他語）"
  };
  const variantLabel = langLabelMap[langCode] || "未知語言";

  const prompt = (langCode === "jav" || langCode === "sun")
    ? `這段文字是以 ${variantLabel} 撰寫，請先轉換為標準 Bahasa Indonesia，再翻譯為以下語言：${filteredTargets.join("、")}。\n請嚴格依照以下 JSON 格式回傳：\n{\n  "zh-TW": "...",\n  "en": "...",\n  "id": "..." \n}\n\n原文如下：\n${text}`
    : `請將以下句子分別翻譯成這些語言：${filteredTargets.join("、")}。\n請嚴格依照以下 JSON 格式回傳：\n{\n  "zh-TW": "...",\n  "en": "...",\n  "id": "..." \n}\n\n要翻譯的句子如下：\n${text}`;

  let rawResponseText = "";
  try {
    const chat = geminiModel.startChat();
    const result = await chat.sendMessage(prompt);
    rawResponseText = result.response.text();

    let parsedJson;
    try {
      parsedJson = JSON.parse(rawResponseText);
    } catch (e) {
      const match = rawResponseText.match(/{[\s\S]*}/);
      parsedJson = match && match[0] ? JSON.parse(match[0]) : null;
      if (!parsedJson) throw new Error("Gemini 回傳非 JSON 格式");
    }

    const translations = {};
    for (const lang of filteredTargets) {
      translations[lang] = parsedJson[lang] || "(Gemini 翻譯失敗)";
    }

    return {
      translations,
      variantInfo: variantLabel !== "Bahasa Indonesia" ? variantLabel : null
    };
  } catch (err) {
    console.error("Gemini 錯誤:", err.message);
    const fallback = {};
    for (const lang of filteredTargets) fallback[lang] = "(Gemini API 錯誤)";
    return { translations: fallback, variantInfo: null };
  }
}

async function translateWithGoogle(text, filteredTargets) {
  const outputs = {};
  const headers = { "Content-Type": "application/json" };

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

app.post(
  "/webhook",
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

      let { translations, variantInfo } = await translateWithGeminiSmart(text, filteredTargets);

      const geminiFailed = Object.values(translations).every(v => v.includes("錯誤") || v.includes("失敗"));
      if (geminiFailed) {
        console.warn("⚠️ Gemini 全部失敗，改用 Google fallback");
        translations = await translateWithGoogle(text, filteredTargets);
        variantInfo = null;
      }

      const replyLines = [];

      if (variantInfo) {
        replyLines.push(`🔍 偵測為地方語言：${variantInfo}，以下翻譯為標準 Bahasa Indonesia`);
      }

      for (const lang of filteredTargets) {
        replyLines.push(`${flagMap[lang] || "🌐"} ${translations[lang]}`);
      }

      await lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: replyLines.join("\n\n") || "⚠️ 無翻譯結果"
      });
    }
  }
);

app.use("/", express.json());

const privateHealthPath = "/health-" + process.env.HEALTH_TOKEN;
app.get(privateHealthPath, (req, res) => {
  res.status(200).send("OK (Private Health Check)");
});

app.get("/", (req, res) => {
  res.send("✅ LINE 翻譯機器人 (Gemini + Google fallback) 正常運作中");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server listening on port ${port}`);
});

// 每 15 分鐘 ping 自己避免 Render 睡眠
cron.schedule("*/15 * * * *", async () => {
  const url = process.env.RENDER_EXTERNAL_URL || "https://your-app-name.onrender.com";
  try {
    const res = await fetch(url);
    console.log(`⏰ 自我喚醒成功：HTTP ${res.status}`);
  } catch (err) {
    console.error("⚠️ 自我喚醒失敗：", err.message);
  }
});
