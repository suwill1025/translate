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
// 修改點：要求 Gemini 回傳巢狀 JSON，包含 "detected_lang"
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

/**
 * 使用 Gemini API 進行翻譯與語言偵測
 */
async function translateWithGemini(text) {
  const prompt = `請翻譯以下句子：\n${text}`;
  
  try {
    const chat = genAI.getGenerativeModel({
        model: "gemini-2.5-flash", 
        systemInstruction: SYSTEM_INSTRUCTION,
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
      // 嘗試解析 JSON，並處理可能包含的 Markdown 標記
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
    console.error("⚠️ Gemini API 錯誤:", error.message);
    // 建構錯誤回傳物件
    const errorTrans = {};
    targetLangs.forEach(l => errorTrans[l] = "(Gemini 錯誤)");
    return { success: false, detectedLang: null, translations: errorTrans };
  }
}

/**
 * [備援] 使用 Google Translate API 偵測語言
 */
async function detectLanguageGoogle(text) {
    if (!GOOGLE_TRANSLATE_API_KEY) return null;
    try {
        const res = await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TRANSLATE_API_KEY}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: text })
        });
        const data = await res.json();
        const lang = data.data?.detections?.[0]?.[0]?.language;
        // 統一繁簡中代碼
        if (lang === 'zh' || lang === 'zh-CN') return 'zh-TW';
        return lang;
    } catch (e) {
        console.error("Google Detect Error:", e.message);
        return null;
    }
}

/**
 * [備援] 使用 Google Translate API 進行翻譯
 */
async function translateWithGoogle(text, sourceLang) { 
  if (!GOOGLE_TRANSLATE_API_KEY) return targetLangs.reduce((acc, l) => ({...acc, [l]: "(備援未設定)"}), {});
  
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
      outputs[lang] = data.data?.translations?.[0]?.translatedText || "(Google 失敗)";
    } catch (e) {
        outputs[lang] = "(Google API 錯誤)";
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

app.get("/", (req, res) => res.send("✅ Bot is running."));

// --- 主邏輯 ---

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();
  
  console.log(`📨 收到訊息: "${text}"`);
  
  let translations;
  let sourceLang;

  // 1. 優先使用 Gemini 翻譯 + 偵測
  const geminiResult = await translateWithGemini(text);
  
  if (geminiResult.success) {
      console.log("✅ Gemini 成功");
      translations = geminiResult.translations;
      sourceLang = geminiResult.detectedLang;
  } else {
      // 2. Gemini 失敗，啟動 Google 備援
      console.log("⚠️ Gemini 失敗，切換至 Google 備援");
      sourceLang = await detectLanguageGoogle(text); // 備援時才呼叫 Google Detect
      translations = await translateWithGoogle(text, sourceLang);
  }

  console.log(`🔍 偵測語言: ${sourceLang || "未知"}`);

  // 3. 過濾與排版 (關鍵修改區)
  const replyLines = targetLangs
    .filter(lang => {
        const result = translations[lang];
        
        // A. 基本過濾：排除無效結果
        if (!result || result.includes("(失敗)") || result.includes("(錯誤)")) return false;

        // B. 語言代碼過濾：如果目標語言就是來源語言，排除
        if (sourceLang) {
            const s = sourceLang.toLowerCase();
            const t = lang.toLowerCase();
            if (t.startsWith(s)) return false; // en-US vs en
            if ((s === 'zh' || s === 'zh-cn') && t === 'zh-tw') return false; // 中文特例
        }

        // C. 強力內容比對過濾 (解決標點符號差異導致過濾失敗的問題)
        // 正規表達式：移除所有非字母(L)和非數字(N)的字元
        const normalize = (str) => str.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
        
        const cleanInput = normalize(text);
        const cleanResult = normalize(result);

        // 如果正規化後的內容一樣 (例如 "Hello!" vs "hello")，則視為相同，過濾掉
        if (cleanInput === cleanResult) return false;
        
        return true;
    })
    .map(lang => `${flagMap[lang] || "🌐"} ${translations[lang]}`)
    .join("\n\n");

  // 如果沒有任何結果 (可能全被過濾了)，則不回覆或回覆提示
  if (!replyLines) {
    console.log("🚫 無需翻譯 (結果與原文相同)");
    return; // 選擇不回覆，避免洗版
  }
    
  console.log(`💬 回覆:\n${replyLines}`);
  return lineClient.replyMessage(event.replyToken, { type: "text", text: replyLines });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
