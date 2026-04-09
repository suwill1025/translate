// VERSION: 2.9 (自動隱藏輸入語言版)
import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const lineClient = new Client(lineConfig);

const targetLangs = ["zh-TW", "en", "id"];
const flagMap = { "zh-TW": "🇹🇼", "en": "🇺🇸", "id": "🇮🇩" };

async function translateWithGemini(text) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      // 🌟 修正點：要求 Gemini 偵測輸入語言，並回傳 detected_lang
      systemInstruction: `You are an expert translator. Translate the input into Traditional Chinese, English, and Indonesian. 
      Return ONLY valid JSON in this exact format:
      {
        "detected_lang": "zh-TW", // 若輸入為英文則填 "en"，印尼文則填 "id"
        "translations": {
          "zh-TW": "...",
          "en": "...",
          "id": "..."
        }
      }`,
      generationConfig: { responseMimeType: "application/json" }
    });

    const result = await model.generateContent(text);
    const data = JSON.parse(result.response.text());
    
    return { success: true, data: data };
  } catch (error) {
    console.error(`[v2.9 Error]: ${error.message}`);
    return { success: false, error: error.message };
  }
}

app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  res.status(200).send("OK");
  
  req.body.events.forEach(async (event) => {
    if (event.type !== "message" || event.message.type !== "text") return;
    
    const result = await translateWithGemini(event.message.text.trim());
    
    if (result.success) {
      const { detected_lang, translations } = result.data;
      
      // 🌟 修正點：用 filter 把「偵測到的來源語言」直接過濾掉不顯示
      const reply = targetLangs
        .filter(lang => lang !== detected_lang) // 如果輸入中文(zh-TW)，就不顯示
