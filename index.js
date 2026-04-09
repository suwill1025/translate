// VERSION: 2.6 (診斷模式)
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

// 🌟 核心：自動偵測這把 Key 能用什麼
async function diagnosticTranslate(text) {
  try {
    // 1. 先列出所有可用的模型名稱
    const modelList = await genAI.listModels();
    const availableNames = modelList.models.map(m => m.name.replace("models/", ""));
    console.log("可用模型清單:", availableNames);

    // 2. 從清單中選一個含有 "flash" 字眼的來用，如果沒有就選第一個
    const bestModel = availableNames.find(n => n.includes("flash")) || availableNames[0];

    if (!bestModel) throw new Error("你的 API Key 找不到任何可用模型！");

    const model = genAI.getGenerativeModel({
      model: bestModel,
      systemInstruction: "Translate to Traditional Chinese, English, Indonesian. Return JSON.",
      generationConfig: { responseMimeType: "application/json" }
    });

    const result = await model.generateContent(text);
    const data = JSON.parse(result.response.text());
    
    return { success: true, translations: data.translations, modelUsed: bestModel };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  res.status(200).send("OK");
  req.body.events.forEach(async (event) => {
    if (event.type !== "message" || event.message.type !== "text") return;
    
    const result = await diagnosticTranslate(event.message.text.trim());
    
    if (result.success) {
      const reply = `✅ 成功 (使用模型: ${result.modelUsed})\n\n🇹🇼 ${result.translations["zh-TW"]}\n\n🇺🇸 ${result.translations["en"]}\n\n🇮🇩 ${result.translations["id"]}`;
      lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
    } else {
      // 🌟 失敗時，把「所有可能的模型」印出來給你選
      try {
        const modelList = await genAI.listModels();
        const names = modelList.models.map(m => m.name.replace("models/", "")).join(", ");
        lineClient.replyMessage(event.replyToken, { 
          type: "text", 
          text: `❌ [v2.6] 診斷失敗\n原因: ${result.error}\n\n💡 你的 Key 權限可見模型有：\n${names || "（無）"}` 
        });
      } catch (e) {
        lineClient.replyMessage(event.replyToken, { 
          type: "text", 
          text: `❌ [v2.6] 完全崩潰\n原因: 連模型清單都抓不到。\n💡 這代表 API Key 的權限設定有問題！` 
        });
      }
    }
  });
});

app.get("/", (req, res) => res.send("✅ v2.6 Diagnostic Mode Online."));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 v2.6 Ready`);
});
