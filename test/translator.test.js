import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  createTranslator, createEventHandler, buildReplyMessages, validateTranslation,
  InvalidTranslationError, TranslationTimeoutError, DEFAULT_MODELS
} from "../translator.js";

const sample = (language = "zh-TW") => ({
  detected_lang: language,
  translations: { "zh-TW": "明天下午 3 點不要出門。", en: "Do not go out tomorrow at 3 p.m.", id: "Jangan keluar besok jam 3 sore." }
});
const response = data => ({ text: JSON.stringify(data) });
const logger = { warn() {}, error() {} };
const event = (id = "event-1", text = "明天下午 3 點不要出門。") => ({
  type: "message", webhookEventId: id, replyToken: "test-reply-token",
  message: { id, type: "text", text }
});

test("each supported source language is excluded from the reply", () => {
  for (const [lang, flag] of [["zh-TW", "🇹🇼"], ["en", "🇺🇸"], ["id", "🇮🇩"]]) {
    const text = buildReplyMessages(sample(lang)).map(message => message.text).join("");
    assert.equal(text.includes(flag), false);
    assert.equal((text.match(/🇹🇼|🇺🇸|🇮🇩/gu) || []).length, 2);
  }
});

test("common language aliases are normalized; mixed text returns all three", () => {
  for (const [input, output] of [["zh", "zh-TW"], ["zh_Hans", "zh-TW"], ["en-US", "en"], ["id-ID", "id"]]) {
    assert.equal(validateTranslation(sample(input)).detected_lang, output);
  }
  assert.equal((buildReplyMessages(sample("mixed"))[0].text.match(/🇹🇼|🇺🇸|🇮🇩/gu) || []).length, 3);
});

test("empty, missing, non-string translations and unknown language codes are rejected", () => {
  const empty = sample(); empty.translations.en = " ";
  const number = sample(); number.translations.id = 123;
  for (const data of [{}, { detected_lang: "zh-TW", translations: {} }, empty, number, sample("bad-code")]) {
    assert.throws(() => validateTranslation(data), InvalidTranslationError);
  }
});

test("primary model receives structured output, time limit, and no hidden SDK retries", async () => {
  const requests = [];
  const translate = createTranslator({ logger, generateContent: async request => { requests.push(request); return response(sample()); } });
  assert.equal((await translate("test")).detected_lang, "zh-TW");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "gemini-3.5-flash-lite");
  assert.equal(requests[0].config.responseMimeType, "application/json");
  assert.deepEqual(requests[0].config.responseJsonSchema.required, ["detected_lang", "translations"]);
  assert.equal(requests[0].config.httpOptions.retryOptions.attempts, 1);
  assert.equal(requests[0].config.httpOptions.timeout, 12000);
});

test("503, 429, and unavailable model errors use the next live fallback", async () => {
  for (const status of [503, 429, 404]) {
    const models = [];
    const translate = createTranslator({ logger, generateContent: async request => {
      models.push(request.model);
      if (models.length === 1) throw Object.assign(new Error("provider failure"), { status });
      return response(sample());
    } });
    await translate("test");
    assert.deepEqual(models, DEFAULT_MODELS.slice(0, 2));
  }
});

test("authentication and invalid request errors stop without useless fallback", async () => {
  for (const status of [400, 401, 403]) {
    let calls = 0;
    const error = Object.assign(new Error("not retryable"), { status });
    const translate = createTranslator({ logger, generateContent: async () => { calls++; throw error; } });
    await assert.rejects(translate("test"), failure => failure === error);
    assert.equal(calls, 1);
  }
});

test("malformed output is retried and never accepted as a successful translation", async () => {
  let calls = 0;
  const translate = createTranslator({ logger, generateContent: async () => {
    calls++;
    if (calls === 1) return { text: "not JSON" };
    if (calls === 2) return response({});
    return response(sample());
  } });
  assert.equal((await translate("test")).detected_lang, "zh-TW");
  assert.equal(calls, 3);
});

test("a hanging request is aborted and fallback can still succeed", async () => {
  let calls = 0, signal;
  const translate = createTranslator({ logger, timeoutMs: 15, totalTimeoutMs: 200, generateContent: request => {
    calls++;
    if (calls === 1) { signal = request.config.abortSignal; return new Promise(() => {}); }
    return response(sample());
  } });
  await translate("test");
  assert.equal(signal.aborted, true);
  assert.equal(calls, 2);
});

test("overall time limit stops hanging requests before trying all models", async () => {
  let calls = 0;
  const translate = createTranslator({ logger, timeoutMs: 100, totalTimeoutMs: 15, generateContent: () => { calls++; return new Promise(() => {}); } });
  await assert.rejects(translate("test"), TranslationTimeoutError);
  assert.ok(calls <= 2);
});

test("long replies are split safely, preserving content and emoji", () => {
  const data = sample();
  data.translations.en = "A".repeat(4494) + "😀" + "B".repeat(1000);
  const messages = buildReplyMessages(data);
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => message.text.length <= 4500));
  assert.equal(messages.map(message => message.text).join(""), `🇺🇸 ${data.translations.en}\n\n🇮🇩 ${data.translations.id}`);
  assert.ok(messages.every(message => !/[\uD800-\uDBFF]$/.test(message.text)));
});

test("duplicate webhook deliveries are translated and replied to only once", async () => {
  let translations = 0, replies = 0;
  const handle = createEventHandler({ logger,
    translate: async () => { translations++; await new Promise(resolve => setTimeout(resolve, 5)); return sample(); },
    replyMessage: async () => { replies++; }
  });
  await Promise.all([handle(event()), handle({ ...event(), deliveryContext: { isRedelivery: true } })]);
  assert.equal(translations, 1); assert.equal(replies, 1);
});

test("provider failures become friendly replies without revealing provider details", async () => {
  const sent = [], logs = [];
  const failure = Object.assign(new Error("secret-key and private-user-content"), { status: 429 });
  const handle = createEventHandler({ logger: { warn: (...args) => logs.push(args) },
    translate: async () => { throw failure; }, replyMessage: async (token, messages) => sent.push(messages)
  });
  await handle(event());
  assert.equal(sent.length, 1);
  assert.match(sent[0][0].text, /使用量/);
  assert.equal(JSON.stringify([sent, logs]).includes("secret-key"), false);
});

test("LINE send failure is awaited, caught, and is not blindly retried", async () => {
  const logs = []; let calls = 0;
  const handle = createEventHandler({ logger: { warn: (...args) => logs.push(args) },
    translate: async () => sample(), replyMessage: async () => { calls++; throw new Error("send failed"); }
  });
  await assert.doesNotReject(handle(event()));
  assert.equal(calls, 1);
  assert.equal(logs.at(-1)[0], "line_reply_failed");
});

test("non-text, blank messages, and missing tokens don't trigger paid calls", async () => {
  let calls = 0;
  const handle = createEventHandler({ logger, translate: async () => { calls++; return sample(); }, replyMessage: async () => { calls++; } });
  await handle({ ...event(), message: { type: "image" } });
  await handle(event("blank", " "));
  await handle({ ...event(), replyToken: undefined });
  assert.equal(calls, 0);
});

test("overlong input receives a splitting instruction without invoking Gemini", async () => {
  let calls = 0; const sent = [];
  const handle = createEventHandler({ logger, translate: async () => { calls++; return sample(); }, replyMessage: async (token, messages) => sent.push(messages) });
  await handle(event("long", "A".repeat(3001)));
  assert.equal(calls, 0); assert.match(sent[0][0].text, /3,000/);
});

test("real Google SDK serializes schema and reads translations using a mock HTTP transport", async () => {
  const { GoogleGenAI } = await import("@google/genai");
  let body;
  const ai = new GoogleGenAI({ apiKey: "test-key", httpOptions: { fetch: async (url, init) => {
    assert.match(String(url), /gemini-3\.5-flash-lite:generateContent/);
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(sample()) }] }, finishReason: "STOP" }] }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  } } });
  const translate = createTranslator({ logger, generateContent: request => ai.models.generateContent(request) });
  assert.equal((await translate("test")).detected_lang, "zh-TW");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(body.generationConfig.responseJsonSchema.required, ["detected_lang", "translations"]);
});

test("real server starts, verifies LINE signatures, and accepts the empty verification webhook", async () => {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ["index.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), LINE_CHANNEL_ACCESS_TOKEN: "test-token", LINE_CHANNEL_SECRET: "test-secret", GEMINI_API_KEY: "test-key" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => { throw new Error("Server exited before startup"); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Server startup timed out")), 10000); timer.unref(); })
    ]);
    const base = `http://127.0.0.1:${port}`;
    assert.match(await (await fetch(base)).text(), /v5\.0\.0/);
    const body = JSON.stringify({ events: [] });
    const signature = createHmac("sha256", "test-secret").update(body).digest("base64");
    assert.equal((await fetch(`${base}/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-line-signature": signature }, body })).status, 200);
    assert.equal((await fetch(`${base}/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-line-signature": "invalid" }, body })).status, 400);
  } finally {
    const exited = once(child, "exit"); child.kill(); await exited;
  }
});
