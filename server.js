import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk"; 
import fetch from "node-fetch";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

const app = express();

// 設定 LINE Config
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// 初始化 LINE Client
const lineClient = new Client(lineConfig);

// --- Gemini API 設定 ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("錯誤：GEMINI_API_KEY 未設定！請檢查您的 .env 檔案。");
  process.exit(1);
}

// 系統指令：適度保留要求，平衡品質與速度
const SYSTEM_INSTRUCTION = `你是一個專業且可靠的多語種翻譯引擎。
主要任務：將使用者輸入的文本精確翻譯成繁體中文 (zh-TW)、英文 (en) 和印尼文 (id)。

輸出要求：
- 必須以嚴格的純 JSON 格式回覆，不含 Markdown。
- 格式範例：
{
  "zh-TW": "...",
  "en": "...",
  "id": "..."
}`;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
// 注意：這裡只設置了通用模型，實際翻譯時會在 translateWithGemini 中使用 startChat 確保系統指令生效。
const geminiModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash", 
  systemInstruction: SYSTEM_INSTRUCTION,
  safetySettings: [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  ],
});

const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
const targetLangs = ["zh-TW", "en", "id"];
const flagMap = {
  "zh-TW": "🇹🇼",
  "en": "🇺🇸",
  "id": "🇮🇩"
};

/**
 * 使用 Google Translate API 偵測語言
 * @returns {string} 偵測到的語言代碼 (e.g., 'zh-TW', 'en')
 */
async function detectLanguage(text) {
    // 檢查是否有設定備援 API 金鑰，如果沒有，則無法偵測語言
    if (!GOOGLE_TRANSLATE_API_KEY) return null;
    const headers = { "Content-Type": "application/json" };
    try {
        const detectRes = await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TRANSLATE_API_KEY}`, {
            method: "POST", headers, body: JSON.stringify({ q: text })
        });
        if (detectRes.ok) {
            const detectData = await detectRes.json();
            if (detectData.data?.detections?.[0]?.[0]) {
                const detectedLang = detectData.data.detections[0][0].language;
                // Google Translate 對繁體中文回傳 'zh-TW'，對簡體中文回傳 'zh-CN'。
                // 由於我們的目標是 'zh-TW'，我們將所有 'zh' 或 'zh-CN' 都視為繁體中文的來源。
                if (detectedLang === 'zh' || detectedLang === 'zh-CN') return 'zh-TW';
                return detectedLang;
            }
        }
    } catch (e) {
        console.error("Google Detect Error:", e.message);
    }
    return null;
}

/**
 * 使用 Gemini API 進行翻譯
 */
async function translateWithGemini(text) {
  // 將所有語言代碼標記為目標語言
  const prompt = `翻譯以下句子，並嚴格遵循 JSON 格式，將繁體中文、英文、印尼文的翻譯結果分別標記在 "zh-TW", "en", "id" 欄位中。
句子：${text}`;
  
  try {
    // 每次呼叫都創建一個新的 Chat 實例，確保系統指令被正確應用
    const chat = genAI.getGenerativeModel({
        model: "gemini-2.5-flash", 
        systemInstruction: SYSTEM_INSTRUCTION,
    }).startChat();
    
    // FIX: 直接傳遞 prompt 字串給 sendMessage
    const result = await chat.sendMessage(prompt);
    const rawResponseText = result.response.text();

    let parsedJson;
    try {
      parsedJson = JSON.parse(rawResponseText);
    } catch (e) {
      // 嘗試提取 JSON (處理模型偶爾會輸出 Markdown 格式的 JSON)
      const match = rawResponseText.match(/\{[\s\S]*\}/); 
      if (match && match[0]) {
        try {
            parsedJson = JSON.parse(match[0]);
        } catch (e_inner) {
            throw new Error("Gemini API 回傳的 JSON 無法解析");
        }
      } else {
        throw new Error("Gemini API 回傳格式錯誤或非 JSON");
      }
    }
    
    const translations = {};
    let oneSuccess = false;
    for (const lang of targetLangs) {
      if (parsedJson[lang] && typeof parsedJson[lang] === 'string') {
        translations[lang] = parsedJson[lang].trim(); // 去除翻譯結果前後空白
        oneSuccess = true;
      } else {
        translations[lang] = "(Gemini 翻譯失敗)";
      }
    }
    
    if (!oneSuccess) throw new Error("Gemini 解析後未找到有效翻譯");
    return translations;

  } catch (error) {
    console.error("Gemini API 錯誤:", error.message);
    const errorTranslations = {};
    for (const lang of targetLangs) {
      errorTranslations[lang] = "(Gemini API 錯誤)";
    }
    return errorTranslations;
  }
}

/**
 * 使用 Google Translate API v2 (備援)
 */
async function translateWithGoogle(text, sourceLang) { 
  if (!GOOGLE_TRANSLATE_API_KEY) {
    console.warn("未設定 GOOGLE_TRANSLATE_API_KEY，無法備援。");
    return targetLangs.reduce((acc, lang) => ({...acc, [lang]: "(備援未設定)"}), {});
  }
  
  const headers = { "Content-Type": "application/json" };
  const outputs = {};
  
  for (const lang of targetLangs) {
    // 如果偵測到的語言與目標語言相同，則不需要翻譯
    if (sourceLang && lang.startsWith(sourceLang)) { 
        outputs[lang] = text; 
        continue;
    }
    
    try {
      const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_API_KEY}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ q: text, target: lang, format: "text", source: sourceLang || "auto" })
      });

      if (!res.ok) {
        outputs[lang] = "(Google 翻譯失敗)";
        continue;
      }
      const data = await res.json();
      outputs[lang] = data.data?.translations?.[0]?.translatedText || "(Google 翻譯錯誤)";
    } catch (e) {
        outputs[lang] = "(Google API 失敗)";
    }
  }
  return outputs;
}

// --- 路由設定 ---

// 1. Webhook 路由：只有這裡才使用 lineMiddleware
app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  res.status(200).send("OK");
  
  if (!req.body.events || req.body.events.length === 0) return;
  
  req.body.events.forEach(event => handleEvent(event).catch(err => {
    console.error("Event Error:", err);
  }));
});

// 2. 一般路由 (給 Render 健康檢查用)
app.get("/", (req, res) => {
  res.send("✅ LINE Translation Bot is running.");
});

// 3. 全域錯誤處理 (防止 Crash)
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('Bad JSON');
    return res.status(400).send({ status: 400, message: err.message });
  }
  if (err.message === 'no signature' || err.message === 'signature validation failed') {
    console.error('⚠️ Signature validation failed. (Is someone accessing webhook directly?)');
    return res.status(401).send("Signature validation failed");
  }
  next();
});


async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();
  
  console.log(`📨 收到: "${text}"`);
  
  // 步驟 1: 偵測原始語言 (使用 Google Translate API 偵測)
  const sourceLang = await detectLanguage(text);
  console.log(`🔍 偵測到原始語言: ${sourceLang}`);

  // 步驟 2: 進行 Gemini 翻譯
  let translations = await translateWithGemini(text);

  // 步驟 3: 檢查是否失敗並切換備援
  const geminiFailed = targetLangs.every(lang => translations[lang].includes("(Gemini"));
  if (geminiFailed) {
    console.warn("⚠️ Gemini 失敗，切換至 Google...");
    translations = await translateWithGoogle(text, sourceLang); // 傳入 sourceLang
  }

  // 步驟 4: 篩選並格式化回覆
  const replyLines = targetLangs
    .filter(lang => {
        const result = translations[lang];
        // 1. 排除翻譯失敗的結果
        if (!result || result.includes("(失敗)") || result.includes("(錯誤)")) return false;
        
        // 2. 排除原文語言的翻譯結果（例如輸入中文，就不回覆中文翻譯）
        // 這裡使用 startsWith 是因為 Google Detect 有時回傳 zh-CN, zh, zh-TW
        if (sourceLang && lang.startsWith(sourceLang)) {
            return false;
        }

        // 3. 排除與原文內容完全一樣的翻譯結果（作為額外保險）
        if (result.trim().toLowerCase() === text.trim().toLowerCase()) return false;
        
        return true;
    })
    .map(lang => `${flagMap[lang] || "🌐"} ${translations[lang]}`)
    .join("\n\n");

  if (!replyLines) {
    return lineClient.replyMessage(event.replyToken, { type: "text", text: "無需翻譯或翻譯失敗。" });
  }
    
  console.log(`💬 回覆:\n${replyLines}`);
  return lineClient.replyMessage(event.replyToken, { type: "text", text: replyLines });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
