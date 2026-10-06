import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import { GoogleGenAI } from "@google/genai";
import { createTranslator, createEventHandler, DEFAULT_MODELS, VERSION } from "./translator.js";

const required = ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET", "GEMINI_API_KEY"];
const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN.trim(),
  channelSecret: process.env.LINE_CHANNEL_SECRET.trim()
};
const lineClient = new Client(lineConfig);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() });
const models = [
  process.env.GEMINI_MODEL?.trim() || DEFAULT_MODELS[0],
  ...(process.env.GEMINI_FALLBACK_MODELS === undefined
    ? DEFAULT_MODELS.slice(1)
    : process.env.GEMINI_FALLBACK_MODELS.split(","))
];
const translate = createTranslator({ generateContent: request => ai.models.generateContent(request), models });
const handleEvent = createEventHandler({
  translate,
  replyMessage: (token, messages) => lineClient.replyMessage(token, messages)
});

const app = express();
app.post("/webhook", lineMiddleware(lineConfig), (req, res) => {
  // Validate the signature before acknowledging; process events asynchronously afterwards.
  res.status(200).send("OK");
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  void Promise.allSettled(events.map(handleEvent)).then(results => {
    for (const result of results) {
      if (result.status === "rejected") console.error("webhook_event_failed", { type: result.reason?.name });
    }
  });
});
app.get("/", (req, res) => res.send(`✅ LINE Translator v${VERSION} is Online.`));
app.use((error, req, res, next) => {
  console.error("webhook_request_failed", { type: error?.name });
  if (res.headersSent) return next(error);
  res.status(400).send("Invalid webhook request");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`LINE Translator v${VERSION} running on port ${PORT}`));
