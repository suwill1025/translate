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
// 注意：gemini-pro (1.0) 對 systemInstruction 支援度較低，我們稍後會把它併入 Prompt
const SYSTEM_PROMPT_TEXT = `你是一個專業的多語種翻譯引擎。
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

// 輔助函式：延遲等待
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 使用 Gemini API 進行翻譯 (含模型自動切換與重試)
 */
async function translateWithGemini(text) {
  // 我們準備兩個模型：首選是 Flash-001 (精確版)，備案是 Pro (兼容版)
  const modelsToTry = ["gemini-1.5-flash-001", "gemini-pro"];
  
  // 嘗試每個模型
  for (const modelName of modelsToTry) {
    console.log(`🤖 嘗試使用模型: ${modelName}`);
    
    try {
      // 針對 gemini-pro，我們把 system instruction 塞進 prompt 裡比較保險
      // 針對 1.5 flash，我們使用正規的 systemInstruction 參數
      let modelConfig = {
        model: modelName,
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
      };

      if (modelName.includes("1.5")) {
        modelConfig.systemInstruction = SYSTEM_PROMPT_TEXT;
      }

      const chat = genAI.getGenerativeModel(modelConfig).startChat();
      
      // 如果是舊模型，手動把系統指令加在最前面
      let finalPrompt = `請翻譯以下句子：\n${text}`;
      if (!modelName.includes("1.5")) {
        finalPrompt = `${SYSTEM_PROMPT_TEXT}\n\n使用者輸入：${text}`;
      }

      const result = await chat.sendMessage(finalPrompt);
      const rawResponseText = result.response.text();

      // --- JSON 解析 ---
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

      if (!parsedJson.translations) throw new Error("JSON 缺少 translations");

      // 轉換結果
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
      // 錯誤處理
      console.error(`❌ 模型 ${modelName} 失敗:`, error.message);

      // 如果是 404 (找不到模型)，或是 400 (不支援)，我們就換下一個模型試試看
      // 如果這已經是最後一個模型，那就沒戲唱了
      if (modelName === modelsToTry[modelsToTry.length - 1]) {
         console.error("💀 所有模型都嘗試失敗。");
      } else {
         console.warn("⚠️ 切換至下一個備援模型...");
         continue; // 進入下一圈 for loop (換模型)
      }
    }
  }

  // 如果跑到這裡代表全部失敗
  const errorTrans = {};
  targetLangs.forEach(l => errorTrans[l] = "(Gemini 全面癱瘓)");
  return { success: false, detectedLang: null, translations: errorTrans };
}

/**
 * [備援] Google Translate Detect
 */
async function detectLanguageGoogle(text) {
  if (!GOOGLE_TRANSLATE_API_KEY) return null;
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
    console.error("Google Detect Error:", e.message);
    return null;
  }
}

/**
 * [備援] Google Translate
 */
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
      if (data.error) {
         outputs[lang] = "(Google API 錯誤)";
      } else {
         outputs[lang] = data.data?.translations?.[0]?.translatedText || "(Google 失敗)";
      }
    } catch (e) {
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

app.get("/", (req, res) => res.send("✅ Bot is running with Auto-Fallback Strategy (Flash -> Pro)."));

// --- 主邏輯 ---

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();

  console.log(`📨 收到訊息: "${text}"`);

  let translations;
  let sourceLang;

  // 1. 優先使用 Gemini (自動切換模型)
  const geminiResult = await translateWithGemini(text);

  if (geminiResult.success) {
    console.log("✅ Gemini 成功");
    translations = geminiResult.translations;
    sourceLang = geminiResult.detectedLang;
  } else {
    // 2. Gemini 全倒，切換 Google 備援
    console.log("⚠️ Gemini 全數失敗，切換至 Google 備援");
    sourceLang = await detectLanguageGoogle(text);
    translations = await translateWithGoogle(text, sourceLang);
  }

  console.log(`🔍 偵測語言: ${sourceLang || "未知"}`);

  // 3. 過濾與排版
  const replyLines = targetLangs
    .filter(lang => {
      const result = translations[lang];
      if (!result || result.includes("(失敗)") || result.includes("(錯誤)") || result.includes("(連線錯誤)") || result.includes("(備援未設定)") || result.includes("(Gemini 全面癱瘓)")) return false;
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
