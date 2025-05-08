import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk"; // Renamed 'middleware' to 'lineMiddleware' to avoid conflict
import fetch from "node-fetch";
// Removed: import { ChatGPTAPI } from "chatgpt";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

const app = express();

app.use(lineMiddleware({ // Use renamed middleware
  channelSecret: process.env.LINE_CHANNEL_SECRET
}));
app.use(express.json());

const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

// --- Gemini API Setup ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("錯誤：GEMINI_API_KEY 未設定！請檢查您的 .env 檔案。");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({
  model: "gemini-1.5-flash-latest", // 您可以根據需求選擇其他模型，例如 gemini-1.5-pro-latest
  safetySettings: [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  ],
  // generationConfig: { // 如果模型支援直接輸出 JSON，可以設定 responseMimeType
  //   responseMimeType: "application/json",
  // }
});
// --- End Gemini API Setup ---

// Removed ChatGPT initialization
// const chatgpt = new ChatGPTAPI({
//   apiKey: process.env.OPENAI_API_KEY
// });

const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY; // For Google Translate v2 fallback
const targetLangs = ["zh-TW", "en", "id"];
const flagMap = {
  "zh-TW": "🇹🇼",
  "en": "🇺🇸",
  "id": "🇮🇩"
};

async function translateWithGemini(text) {
  const prompt = `請將以下句子分別翻譯成這些語言：繁體中文 (zh-TW)、英文 (en)、印尼文 (id)。
請嚴格依照以下 JSON 格式回傳，不要包含任何 JSON 以外的文字或 markdown 標記 (例如不要用 \`\`\`json ... \`\`\` 包住 JSON)：
{
  "zh-TW": "翻譯後的繁體中文句子",
  "en": "Translated English sentence",
  "id": "Translated Indonesian sentence"
}

要翻譯的句子如下：
${text}`;

  let rawResponseText = "";
  try {
    // 有些模型和 SDK 版本可以直接指定回傳 JSON
    // const result = await geminiModel.generateContent({
    //   contents: [{ role: "user", parts: [{ text: prompt }] }],
    //   generationConfig: { responseMimeType: "application/json" }
    // });
    // const response = result.response;
    // rawResponseText = response.text(); // 如果是 application/json，這應該就是 JSON 字串

    // 使用 chat session 的方式
    const chat = geminiModel.startChat();
    const result = await chat.sendMessage(prompt);
    const response = result.response;
    rawResponseText = response.text();

    let parsedJson;
    try {
      // 嘗試直接解析，適用於 Gemini 直接回傳純 JSON 字串的情況
      parsedJson = JSON.parse(rawResponseText);
    } catch (e) {
      // 若直接解析失敗，嘗試從可能包含 markdown 的字串中提取 JSON
      console.warn("Gemini 回應非純 JSON，嘗試提取:", rawResponseText);
      const match = rawResponseText.match(/{[\s\S]*}/);
      if (match && match[0]) {
        parsedJson = JSON.parse(match[0]);
      } else {
        throw new Error("Gemini API 回傳格式錯誤或非 JSON: " + rawResponseText);
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
    if (!oneSuccess && Object.keys(parsedJson).length > 0) { 
        // JSON 有內容但目標語言都沒成功
        console.warn("Gemini 回傳的 JSON 中未找到有效翻譯:", parsedJson);
    } else if (!oneSuccess) {
        throw new Error("Gemini 解析後未找到任何有效翻譯。");
    }
    return translations;

  } catch (error) {
    console.error("呼叫 Gemini API 或處理其回應時發生錯誤:", error.message);
    if (rawResponseText) {
        console.error("Gemini API 原始回傳 (若有):", rawResponseText);
    }
    const errorTranslations = {};
    for (const lang of targetLangs) {
      errorTranslations[lang] = "(Gemini API 錯誤)";
    }
    return errorTranslations;
  }
}

// translateWithChatGPT function is removed as Gemini is the primary now.

async function translateWithGoogle(text) { // Fallback function using Google Translate API v2
  if (!GOOGLE_TRANSLATE_API_KEY) {
    console.warn("未設定 GOOGLE_TRANSLATE_API_KEY，無法使用 Google Translate v2 備援。");
    const errorTranslations = {};
    for (const lang of targetLangs) {
      errorTranslations[lang] = "(備援翻譯未設定)";
    }
    return errorTranslations;
  }
  const headers = { "Content-Type": "application/json" };
  let sourceLang = "auto"; // Default to auto-detect

  try {
    const detectRes = await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TRANSLATE_API_KEY}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ q: text })
    });
    if (!detectRes.ok) {
        const errorBody = await detectRes.text();
        console.error(`Google Translate v2 語言偵測失敗 (${detectRes.status}): ${errorBody}`);
        // Keep sourceLang as "auto" if detection fails
    } else {
        const detectData = await detectRes.json();
        if (detectData.data && detectData.data.detections && detectData.data.detections[0] && detectData.data.detections[0][0]) {
            sourceLang = detectData.data.detections[0][0].language;
        }
    }
  } catch (e) {
      console.error("Google Translate v2 語言偵測 API 呼叫失敗:", e.message);
      // Keep sourceLang as "auto"
  }


  const outputs = {};
  for (const lang of targetLangs) {
    if (lang.startsWith(sourceLang) && sourceLang !== "auto") { // Avoid translating to detected source language e.g. zh-TW to zh-TW
        outputs[lang] = text; // Or provide a specific message like "(原文無需翻譯)"
        continue;
    }

    try {
      const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_API_KEY}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ q: text, target: lang, format: "text", source: sourceLang === "auto" ? undefined : sourceLang })
      });

      if (!res.ok) {
        const errorBody = await res.text();
        console.error(`Google Translate v2 翻譯失敗 (${res.status}) for ${lang}: ${errorBody}`);
        outputs[lang] = "(Google 翻譯失敗)";
        continue;
      }

      const data = await res.json();
      outputs[lang] = data.data?.translations?.[0]?.translatedText || "(Google 翻譯錯誤)";
    } catch (e) {
        console.error(`Google Translate v2 API 呼叫失敗 for ${lang}:`, e.message);
        outputs[lang] = "(Google API 呼叫失敗)";
    }
  }
  return outputs;
}

app.post("/webhook", (req, res) => {
  res.status(200).send("OK"); // Respond quickly to LINE platform
  if (!req.body.events || req.body.events.length === 0) return;
  
  // Process each event
  req.body.events.forEach(event => {
    handleEvent(event).catch(err => {
      console.error("Event handling error:", err);
      // Optionally send an error message back to LINE user if appropriate
      // For now, just logging to server
    });
  });
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();
  let translations;

  console.log(`📨 收到訊息: "${text}"`);
  console.log("⚙️ 嘗試使用 Gemini API 進行翻譯...");
  translations = await translateWithGemini(text);

  // 檢查 Gemini 是否對所有目標語言都翻譯失敗
  const geminiEffectivelyFailed = targetLangs.every(lang =>
    translations[lang] === "(Gemini API 錯誤)" || translations[lang] === "(Gemini 翻譯失敗)"
  );

  if (geminiEffectivelyFailed) {
    console.warn("⚠️ Gemini API 翻譯全面失敗，嘗試使用 Google Translate v2 備援...");
    translations = await translateWithGoogle(text); // 使用 Google Translate v2 作為備援
  }

  const replyLines = targetLangs
    .filter(lang => translations[lang] && translations[lang] !== "(所有翻譯服務均失敗)" && translations[lang] !== "(備援翻譯未設定)")
    .map(lang => `${flagMap[lang] || "🌐"} ${translations[lang]}`)
    .join("\n\n");

  if (!replyLines) {
    console.log("💬 回覆：無有效翻譯結果。");
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "抱歉，目前無法翻譯您的訊息。"
    });
  }
  
  console.log(`💬 回覆翻譯結果:\n${replyLines}`);
  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: replyLines
  });
}

app.get("/", (req, res) => {
  res.send("✅ LINE 翻譯機器人 (Gemini 版本) 正在運作中");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server listening on port ${port}. 使用 Gemini API 進行翻譯。`);
});
