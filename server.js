import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk"; 
import fetch from "node-fetch";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

const app = express();

// 設定 LINE Middleware
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

app.use(lineMiddleware({
  channelSecret: process.env.LINE_CHANNEL_SECRET
}));
app.use(express.json());

// 初始化 LINE Client
const lineClient = new Client(lineConfig);

// --- Gemini API 設定 ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("錯誤：GEMINI_API_KEY 未設定！請檢查您的 .env 檔案。");
  process.exit(1);
}

// *** 強化後的系統指令 (System Instruction) ***
// 專注於自然與精確度，並強制 JSON 輸出
const SYSTEM_INSTRUCTION = `你是一個專業且可靠的多語種翻譯引擎。
主要任務：將使用者輸入的文本精確翻譯成繁體中文 (zh-TW)、英文 (en) 和印尼文 (id)。

風格與準確性要求：
1. 確保翻譯結果是**最自然、最道地、最口語化**的表達，絕對避免生硬的機器直譯。
2. 必須嚴格保持原文本的**完整語意和語氣**，不可遺漏任何細節。
3. 語法必須正確無誤。

輸出要求：
- 必須以嚴格的純 JSON 格式回覆，不含任何 Markdown 標記 (如 \`\`\`json) 或額外文字。
- 格式範例：
{
  "zh-TW": "...",
  "en": "...",
  "id": "..."
}`;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({
  model: "gemini-1.5-flash-latest", // 使用 Flash 模型保持速度
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
  // Prompt 簡化，主要依賴 SYSTEM_INSTRUCTION
  const prompt = `翻譯以下句子：\n${text}`;

  let rawResponseText = "";
  try {
    const chat = geminiModel.startChat();
    const result = await chat.sendMessage(prompt);
    const response = result.response;
    rawResponseText = response.text();

    let parsedJson;
    try {
      // 嘗試直接解析
      parsedJson = JSON.parse(rawResponseText);
    } catch (e) {
      console.warn("Gemini 回應非純 JSON，嘗試提取:", rawResponseText);
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
    if (rawResponseText) console.error("原始回傳:", rawResponseText);
    
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
    // 1. 偵測語言
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
  // 2. 執行翻譯
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
        console.error(`Google Translate Error (${lang}):`, e.message);
        outputs[lang] = "(Google API 失敗)";
    }
  }
  return outputs;
}

// --- Webhook ---
app.post("/webhook", (req, res) => {
  res.status(200).send("OK");
  if (!req.body.events || req.body.events.length === 0) return;
  req.body.events.forEach(event => handleEvent(event).catch(console.error));
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();
  
  console.log(`📨 收到: "${text}"`);
  console.log("⚙️ 使用 Gemini...");
  let translations = await translateWithGemini(text);

  // 檢查是否失敗
  const geminiFailed = targetLangs.every(lang => translations[lang].includes("(Gemini"));
  if (geminiFailed) {
    console.warn("⚠️ Gemini 失敗，切換至 Google...");
    translations = await translateWithGoogle(text);
  }

  const replyLines = targetLangs
    .filter(lang => translations[lang] && !translations[lang].includes("(失敗)") && !translations[lang].includes("(錯誤)"))
    .map(lang => `${flagMap[lang] || "🌐"} ${translations[lang]}`)
    .join("\n\n");

  if (!replyLines) {
    return lineClient.replyMessage(event.replyToken, { type: "text", text: "無法翻譯，請稍後再試。" });
  }
   
  console.log(`💬 回覆:\n${replyLines}`);
  return lineClient.replyMessage(event.replyToken, { type: "text", text: replyLines });
}

app.get("/", (req, res) => res.send("✅ LINE Translation Bot (Gemini) is running."));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
