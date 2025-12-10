import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import fetch from "node-fetch";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

const app = express();

// --- 設定區 ---
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

// 設定目標語言與國旗
const targetLangs = ["zh-TW", "en", "id"];
const flagMap = {
  "zh-TW": "🇹🇼",
  "en": "🇺🇸",
  "id": "🇮🇩"
};

// --- 系統指令 (System Instruction) ---
const SYSTEM_INSTRUCTION = `你是一個專業的多語種翻譯引擎。
任務：
1. 偵測使用者輸入的語言。
2. 將文本翻譯成繁體中文 (zh-TW)、英文 (en) 和印尼文 (id)。

輸出必須是純 JSON 格式，不要使用 Markdown，格式如下：
{
  "detected_lang": "偵測到的語言代碼 (如 zh, en, id, ja)",
  "translations": {
    "zh-TW": "...",
    "en": "...",
    "id": "..."
  }
}`;

// 輔助函式：延遲等待 (用於重試)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 使用 Gemini API 進行翻譯與語言偵測 (含重試機制)
 */
async function translateWithGemini(text) {
  const prompt = `請翻譯以下句子：\n${text}`;
  const maxRetries = 3; // 最大重試次數

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 使用 1.5-flash-8b (速度最快，適合翻譯)
      const chat = genAI.getGenerativeModel({
        model: "gemini-1.5-flash-8b", 
        systemInstruction: SYSTEM_INSTRUCTION,
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
      }).startChat();

      const result = await chat.sendMessage(prompt);
      const rawResponseText = result.response.text();

      // --- JSON 解析區 ---
      let parsedJson;
      try {
        const cleanJson = rawResponseText.replace(/```json|```/g, "").trim();
        parsedJson = JSON.parse(cleanJson);
      } catch (e) {
        // 二次嘗試：用正則抓取大括號內容
        const match = rawResponseText.match(/\{[\s\S]*\}/);
        if (match && match[0]) {
          parsedJson = JSON.parse(match[0]);
        } else {
          throw new Error("無法解析 JSON");
        }
      }

      // 驗證結構
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
      // 錯誤處理與重試邏輯
      const isRetryable = error.message.includes('503') || error.message.includes('overloaded') || error.message.includes('500');
      
      if (isRetryable && attempt < maxRetries) {
        const waitTime = attempt * 1000; // 第1次等1秒，第2次等2秒...
        console.warn(`⚠️ Gemini 忙碌 (503/Overloaded)，第 ${attempt} 次重試，等待 ${waitTime}ms...`);
        await sleep(waitTime);
        continue; // 進入下一次迴圈
      } else {
        console.error(`❌ Gemini 最終失敗 (嘗試 ${attempt} 次):`, error.message);
        // 如果是最後一次嘗試，或錯誤不可重試，才回傳失敗物件
        if (attempt === maxRetries || !isRetryable) {
            const errorTrans = {};
            targetLangs.forEach(l => errorTrans[l] = "(Gemini 錯誤)");
            return { success: false, detectedLang: null, translations: errorTrans };
        }
      }
    }
  }
}

/**
 * [備援] 使用 Google Translate API 偵測語言
 */
async function detectLanguageGoogle(text) {
  if (!GOOGLE_TRANSLATE_API_KEY) {
    console.warn("⚠️ 未設定 GOOGLE_TRANSLATE_API_KEY，無法使用備援偵測");
    return null;
  }
  try {
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TRANSLATE_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: text })
    });
    const data = await res.json();
    
    if (data.error) throw new Error(JSON.stringify(data.error));

    const lang = data.data?.detections?.[0]?.[0]?.language;
    if (lang === 'zh' || lang === 'zh-CN') return 'zh-TW';
    return lang;
  } catch (e) {
    console.error("❌ Google Detect Error:", e.message);
    return null;
  }
}

/**
 * [備援] 使用 Google Translate API 進行翻譯
 */
async function translateWithGoogle(text, sourceLang) {
  if (!GOOGLE_TRANSLATE_API_KEY) return targetLangs.reduce((acc, l) => ({ ...acc, [l]: "(備援未設定)" }), {});

  const outputs = {};
  for (const lang of targetLangs) {
    // 如果已知來源語言且與目標相同，直接填入原文 (後續會被過濾)
    if (sourceLang && lang.startsWith(sourceLang)) {
      outputs[lang] = text;
      continue;
    }
    try {
      const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: text, target: lang, format: "text", source: sourceLang || "auto" })
      });
      const data = await res.json();
      
      if (data.error) {
         console.error(`Google Translate API Error (${lang}):`, data.error.message);
         outputs[lang] = "(Google API 錯誤)";
      } else {
         outputs[lang] = data.data?.translations?.[0]?.translatedText || "(Google 失敗)";
      }
    } catch (e) {
      console.error(`Google Fetch Error (${lang}):`, e.message);
      outputs[lang] = "(連線錯誤)";
    }
  }
  return outputs;
}

// --- 路由 ---

app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  res.status(200).send("OK");
  if (!req.body.events) return;
  req.body.events.forEach(event => handleEvent(event).catch(console.error));
});

app.get("/", (req, res) => res.send("✅ Bot is running with Gemini 1.5 Flash 8b & Retry Logic."));

// --- 主邏輯 ---

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();

  console.log(`📨 收到訊息: "${text}"`);

  let translations;
  let sourceLang;

  // 1. 優先使用 Gemini 翻譯 + 偵測 (含重試)
  const geminiResult = await translateWithGemini(text);

  if (geminiResult.success) {
    console.log("✅ Gemini 成功");
    translations = geminiResult.translations;
    sourceLang = geminiResult.detectedLang;
  } else {
    // 2. Gemini 失敗，啟動 Google 備援
    console.log("⚠️ Gemini 全數失敗，切換至 Google 備援");
    sourceLang = await detectLanguageGoogle(text);
    translations = await translateWithGoogle(text, sourceLang);
  }

  console.log(`🔍 偵測語言: ${sourceLang || "未知"}`);

  // 3. 過濾與排版
  const replyLines = targetLangs
    .filter(lang => {
      const result = translations[lang];

      // A. 基本過濾
      if (!result || result.includes("(失敗)") || result.includes("(錯誤)") || result.includes("(連線錯誤)") || result.includes("(備援未設定)")) return false;

      // B. 語言代碼過濾
      if (sourceLang) {
        const s = sourceLang.toLowerCase();
        const t = lang.toLowerCase();
        if (t.startsWith(s)) return false;
        if ((s === 'zh' || s === 'zh-cn') && t === 'zh-tw') return false;
      }

      // C. 強力內容比對過濾
      const normalize = (str) => str.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      const cleanInput = normalize(text);
      const cleanResult = normalize(result);

      if (cleanInput === cleanResult) return false;

      return true;
    })
    .map(lang => `${flagMap[lang] || "🌐"} ${translations[lang]}`)
    .join("\n\n");

  if (!replyLines) {
    console.log("🚫 無需翻譯 (結果與原文相同或過濾後為空)");
    return;
  }

  console.log(`💬 回覆:\n${replyLines}`);
  return lineClient.replyMessage(event.replyToken, { type: "text", text: replyLines });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
