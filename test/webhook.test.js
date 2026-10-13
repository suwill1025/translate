import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("webhook waits for processing and LINE reply before acknowledging", async () => {
  const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
  const route = source.slice(source.indexOf('app.post("/webhook"'), source.indexOf('app.get("/"'));
  let handler;
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = { post(path, middleware, callback) { handler = callback; } };
  new Function("app", "lineMiddleware", "lineConfig", "handleEvent", route)(app, () => {}, {}, () => pending);
  let sent = false;
  const res = { status(code) { assert.equal(code, 200); return this; }, send(body) { assert.equal(body, "OK"); sent = true; } };
  const work = handler({ body: { events: [{}] } }, res);
  await Promise.resolve();
  assert.equal(sent, false);
  finish();
  await work;
  assert.equal(sent, true);
});
