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
const geminiModel = genAI.getGenerativeModel({
  // 如果更新套件後還是 404，可以試試 "gemini-1.5-flash-001" 或是 "gemini-pro"
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
 * 使用 Gemini API 進行翻譯
 */
async function translateWithGemini(text) {
  const prompt = `翻譯以下句子：\n${text}`;
  
  try {
    const chat = geminiModel.startChat();
    const result = await chat.sendMessage(prompt);
    const response = result.response;
    const rawResponseText = response.text();

    let parsedJson;
    try {
      parsedJson = JSON.parse(rawResponseText);
    } catch (e) {
      // 嘗試提取 JSON
      const match = rawResponseText.match(/{[\s\S]*}/); 
      if (match && match[0]) {
        parsedJson = JSON.parse(match[0]);
      } else {
        throw new Error("Gemini API 回傳格式錯誤或非 JSON");
      }
    }
    
    const translations = {};
    let oneSuccess = false;
    for (const lang of targetLangs) {
      if (parsedJson[lang] && typeof parsedJson[lang] === 'string') {
        translations[lang] = parsedJson[lang];
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
async function translateWithGoogle(text) { 
  if (!GOOGLE_TRANSLATE_API_KEY) {
    console.warn("未設定 GOOGLE_TRANSLATE_API_KEY，無法備援。");
    return targetLangs.reduce((acc, lang) => ({...acc, [lang]: "(備援未設定)"}), {});
  }
  
  const headers = { "Content-Type": "application/json" };
  let sourceLang = "auto";

  try {
    const detectRes = await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TRANSLATE_API_KEY}`, {
      method: "POST", headers, body: JSON.stringify({ q: text })
    });
    if (detectRes.ok) {
        const detectData = await detectRes.json();
        if (detectData.data?.detections?.[0]?.[0]) {
            sourceLang = detectData.data.detections[0][0].language;
        }
    }
  } catch (e) {
      console.error("Google Detect Error:", e.message);
  }

  const outputs = {};
  for (const lang of targetLangs) {
    if (lang.startsWith(sourceLang) && sourceLang !== "auto") { 
        outputs[lang] = text; 
        continue;
    }
    try {
      const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_API_KEY}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ q: text, target: lang, format: "text", source: sourceLang === "auto" ? undefined : sourceLang })
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
// 注意：lineMiddleware 必須放在這個路徑裡，不能全域使用，否則會導致 no signature 錯誤
app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  res.status(200).send("OK");
  
  if (!req.body.events || req.body.events.length === 0) return;
  
  req.body.events.forEach(event => handleEvent(event).catch(err => {
    console.error("Event Error:", err);
  }));
});

// 2. 一般路由 (給 Render 健康檢查用，不需要簽章)
app.get("/", (req, res) => {
  res.send("✅ LINE Translation Bot is running.");
});

// 3. 全域錯誤處理 (防止 Crash)
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('Bad JSON');
    return res.status(400).send({ status: 400, message: err.message }); // Bad request
  }
  // 處理 LINE Signature 錯誤
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
  let translations = await translateWithGemini(text);

  // 檢查是否失敗
  const geminiFailed = targetLangs.every(lang => translations[lang].includes("(Gemini"));
  if (geminiFailed) {
    console.warn("⚠️ Gemini 失敗，切換至 Google...");
    translations = await translateWithGoogle(text);
  }

  const replyLines = targetLangs
    .filter(lang => {
        const result = translations[lang];
        if (!result || result.includes("(失敗)") || result.includes("(錯誤)")) return false;
        // 排除與原文相同的翻譯 (忽略大小寫與空白)
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
