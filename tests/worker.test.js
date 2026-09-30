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

test("self-test reports a missing key without calling Gemini", async () => {
  const res = await worker.fetch(req(null, { method: "GET", path: "/selftest" }), { ALLOWED_ORIGINS: ORIGIN });
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.step, "key");
  assert.equal(calls.length, 0);
});

test("self-test runs a real sample plan", async () => {
  const body = await (await worker.fetch(req(null, { method: "GET", path: "/selftest" }), env)).json();
  assert.equal(body.ok, true);
  assert.equal(body.days, 1);
});

test("Gemini errors come back with Google's reason, never the key", async () => {
  geminiReply = () => new Response(JSON.stringify({ error: { message: "API key not valid: AIzaSyFAKE123. Please pass a valid API key." } }), { status: 400 });
  const body = await (await worker.fetch(req(good), env)).json();
  assert.equal(body.status, 400);
  assert.match(body.detail, /API key not valid/);
  assert.ok(!body.detail.includes("AIzaSyFAKE123"));
});

test("thinking parts are ignored when reading the plan", async () => {
  geminiReply = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: "planning {not json" }, { text: JSON.stringify(plan) }] } }] }), { status: 200 });
  assert.deepEqual((await (await worker.fetch(req(good), env)).json()).plan, plan);
});

test("each plan request writes one structured log line without personal details", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (x) => lines.push(x);
  try {
    await worker.fetch(req({ ...good, brief: { ...good.brief, notes: "my phone is 98765" } }), env);
  } finally { console.log = orig; }
  assert.equal(lines.length, 1);
  const l = lines[0];
  assert.equal(l.route, "/plan");
  assert.equal(l.status, 200);
  assert.equal(l.dest, "jaipur");
  assert.equal(l.kind, "plan");
  assert.equal(l.gemini.status, 200);
  assert.equal(typeof l.ms, "number");
  assert.ok(!JSON.stringify(l).includes("98765"), "notes never logged");
  assert.ok(!("ip" in l));
});

test("failures are logged with their error code", async () => {
  const lines = [];
  const orig = console.error;
  console.error = (x) => lines.push(x);
  geminiReply = () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 });
  try { await worker.fetch(req(good), env); } finally { console.error = orig; }
  assert.equal(lines[0].status, 503);
  assert.equal(lines[0].error, "upstream_error");
  assert.equal(lines[0].gemini.status, 404);
});
