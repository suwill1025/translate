import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import fetch from "node-fetch";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const lineClient = new Client(lineConfig);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("❌ 錯誤：GEMINI_API_KEY 未設定！");
  process.exit(1);
}

const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const targetLangs = ["zh-TW", "en", "id"];
const flagMap = { "zh-TW": "🇹🇼", "en": "🇺🇸", "id": "🇮🇩" };

// --- 🌟 關鍵修改：System Instruction 優化版 🌟 ---
// 1. 更精簡 (省 Token)
// 2. 強調 "Native Speaker" (道地感)
// 3. 強調 "Authentic/Natural" (拒絕機器翻譯腔)
const SYSTEM_INSTRUCTION = `Act as a native speaker of Traditional Chinese, English, and Indonesian. 
Translate the input into **authentic, natural, and culturally appropriate** language for each target. 
Avoid literal machine translation. Use local idioms where suitable.

Return ONLY raw JSON (no Markdown):
{
  "detected_lang": "detected language code",
  "translations": {
    "zh-TW": "Natural Traditional Chinese",
    "en": "Natural English",
    "id": "Natural Indonesian"
  }
}`;

async function translateWithGemini(text) {
  const prompt = text; // 這裡也不用多廢話了，直接丟原文給它，它看得懂

  try {
   const chat = genAI.getGenerativeModel({
  model: "gemini-3-flash-preview", // 1. 換掉這裡
  systemInstruction: SYSTEM_INSTRUCTION,
  generationConfig: { responseMimeType: "application/json" }, // 2. 多加這行，保證只出 JSON
  // ... 其他不變
})
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      ],
    }).startChat();

    const result = await chat.sendMessage(prompt);
    const rawResponseText = result.response.text();

    let parsedJson;
    try {
      const cleanJson = rawResponseText.replace(/```json|```/g, "").trim();
      parsedJson = JSON.parse(cleanJson);
    } catch (e) {
      const match = rawResponseText.match(/\{[\s\S]*\}/);
      if (match && match[0]) {
        parsedJson = JSON.parse(match[0]);
      } else {
        throw new Error("無法解析 JSON");
      }
    }

    if (!parsedJson.translations) throw new Error("JSON 缺少 translations 欄位");

    const translations = {};
    let oneSuccess = false;

    for (const lang of targetLangs) {
      const t = parsedJson.translations[lang];
      if (t && typeof t === 'string') {
        translations[lang] = t.trim();
        oneSuccess = true;
      } else {
        translations[lang] = "(Gemini 翻譯失敗)";
      }
    }

    if (!oneSuccess) throw new Error("沒有任何有效翻譯");

    return {
      success: true,
      detectedLang: parsedJson.detected_lang || null,
      translations: translations
    };

  } catch (error) {
    console.error("⚠️ Gemini API 錯誤:", error.message);
    const errorTrans = {};
    targetLangs.forEach(l => errorTrans[l] = "(Gemini 錯誤)");
    return { success: false, detectedLang: null, translations: errorTrans };
  }
}

// [備援區維持原樣]
async function detectLanguageGoogle(text) {
  if (!GOOGLE_TRANSLATE_API_KEY) return null;
  try {
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TRANSLATE_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: text })
    });
    const data = await res.json();
    const lang = data.data?.detections?.[0]?.[0]?.language;
    if (lang === 'zh' || lang === 'zh-CN') return 'zh-TW';
    return lang;
  } catch (e) {
    console.error("Google Detect Error:", e.message);
    return null;
  }
}

async function translateWithGoogle(text, sourceLang) {
  if (!GOOGLE_TRANSLATE_API_KEY) return targetLangs.reduce((acc, l) => ({ ...acc, [l]: "(備援未設定)" }), {});

  const outputs = {};
  for (const lang of targetLangs) {
    if (sourceLang && lang.startsWith(sourceLang)) {
      outputs[lang] = text;
      continue;
    }
    try {
      const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_API_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: text, target: lang, format: "text", source: sourceLang || "auto" })
      });
      const data = await res.json();
      outputs[lang] = data.data?.translations?.[0]?.translatedText || "(Google 失敗)";
    } catch (e) {
      outputs[lang] = "(Google API 錯誤)";
    }
  }
  return outputs;
}

app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  res.status(200).send("OK");
  if (!req.body.events) return;
  req.body.events.forEach(event => handleEvent(event).catch(console.error));
});

app.get("/", (req, res) => res.send("✅ Bot is running (Gemini 2.5 Native Mode)."));

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();

  console.log(`📨 收到訊息: "${text}"`);

  let translations;
  let sourceLang;

  const geminiResult = await translateWithGemini(text);

  if (geminiResult.success) {
    console.log("✅ Gemini 成功");
    translations = geminiResult.translations;
    sourceLang = geminiResult.detectedLang;
  } else {
    console.log("⚠️ Gemini 失敗，切換至 Google 備援");
    sourceLang = await detectLanguageGoogle(text);
    translations = await translateWithGoogle(text, sourceLang);
  }

  console.log(`🔍 偵測語言: ${sourceLang || "未知"}`);

  const replyLines = targetLangs
    .filter(lang => {
      const result = translations[lang];
      if (!result || result.includes("(失敗)") || result.includes("(錯誤)")) return false;
      if (sourceLang) {
        const s = sourceLang.toLowerCase();
        const t = lang.toLowerCase();
        if (t.startsWith(s)) return false;
        if ((s === 'zh' || s === 'zh-cn') && t === 'zh-tw') return false;
      }
      const normalize = (str) => str.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      const cleanInput = normalize(text);
      const cleanResult = normalize(result);
      if (cleanInput === cleanResult) return false;
      return true;
    })
    .map(lang => `${flagMap[lang] || "🌐"} ${translations[lang]}`)
    .join("\n\n");

  if (!replyLines) {
    console.log("🚫 無需翻譯");
    return;
  }

  console.log(`💬 回覆:\n${replyLines}`);
  return lineClient.replyMessage(event.replyToken, { type: "text", text: replyLines });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
