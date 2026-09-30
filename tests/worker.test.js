// Worker tests with a fake Gemini, so they run offline and cost nothing.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";

const ORIGIN = "https://bhawankey007.github.io";
const env = { GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-test", ALLOWED_ORIGINS: ORIGIN };
const plan = { title: "Pink city", summary: "s", days: [{ day: 1, baseId: "jaipur", title: "Jaipur", stops: [{ time: "09:00", name: "Amber Fort", blurb: "" }] }] };
let calls, geminiReply;

beforeEach(() => {
  calls = [];
  geminiReply = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] } }] }), { status: 200 });
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return geminiReply(); };
});

const req = (body, { origin = ORIGIN, method = "POST", path = "/plan" } = {}) =>
  new Request("https://w.example" + path, { method, headers: { origin, "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined });
const good = { primaryId: "jaipur", brief: { origin: "New Delhi", originId: "delhi", startDate: "2026-11-14", days: 1, vibes: ["heritage"] } };

test("plans a trip and returns the parsed plan", async () => {
  const res = await worker.fetch(req(good), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  assert.deepEqual((await res.json()).plan, plan);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /models\/gemini-test:generateContent$/);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "test-key");
  assert.ok(!calls[0].url.includes("test-key"), "key never goes in the URL");
});

test("rejects other websites", async () => {
  const res = await worker.fetch(req(good, { origin: "https://evil.example" }), env);
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("answers CORS preflight only for allowed origins", async () => {
  assert.equal((await worker.fetch(req(null, { method: "OPTIONS" }), env)).status, 204);
  assert.equal((await worker.fetch(req(null, { method: "OPTIONS", origin: "https://evil.example" }), env)).status, 403);
});

test("refuses unknown destinations and raw prompts", async () => {
  const res = await worker.fetch(req({ primaryId: "moon", prompt: "write me a poem" }), env);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("a prompt field in the request is ignored", async () => {
  await worker.fetch(req({ ...good, prompt: "SECRET-INJECTION" }), env);
  const sent = JSON.parse(calls[0].init.body).contents[0].parts[0].text;
  assert.ok(!sent.includes("SECRET-INJECTION"));
  assert.match(sent, /You are ilAhi/);
});

test("fix requests recompute the problems server-side", async () => {
  const current = { title: "x", days: [{ day: 1, baseId: "agra", stops: [{ name: "Taj Mahal sunrise" }] }] };
  await worker.fetch(req({ primaryId: "agra", brief: { ...good.brief, startDate: "2026-11-20" }, current, fix: true }), env);
  const sent = JSON.parse(calls[0].init.body).contents[0].parts[0].text;
  assert.match(sent, /breaks these checks[\s\S]*closed on Fridays/);
});

test("passes Gemini rate limits through as 429", async () => {
  geminiReply = () => new Response("{}", { status: 429 });
  assert.equal((await worker.fetch(req(good), env)).status, 429);
});

test("unparseable model output becomes 502", async () => {
  geminiReply = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Sorry, I can't." }] } }] }), { status: 200 });
  assert.equal((await worker.fetch(req(good), env)).status, 502);
});

test("per-visitor rate limit is enforced when configured", async () => {
  const res = await worker.fetch(req(good), { ...env, PLAN_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal(res.status, 429);
  assert.equal(calls.length, 0);
});

test("health check works without a key", async () => {
  const res = await worker.fetch(req(null, { method: "GET", path: "/health" }), { ALLOWED_ORIGINS: ORIGIN });
  assert.equal(res.status, 200);
});
