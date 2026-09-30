// ilAhi planner Worker (Cloudflare Workers, free plan).
// Accepts a structured trip request from the ilAhi site, builds the prompt itself
// with the same planner code the site uses, asks Gemini, and returns the plan JSON.
// It never accepts a raw prompt, so it can't be used as a general AI proxy.
//
// Secrets / vars (see wrangler.toml and docs/SETUP.md):
//   GEMINI_API_KEY   secret, from Google AI Studio
//   GEMINI_MODEL     e.g. "gemini-3.5-flash"
//   ALLOWED_ORIGINS  comma-separated, e.g. "https://bhawankey007.github.io"
//   PLAN_LIMITER     optional rate-limit binding

import { Engine } from "../../site/engine.js";
import { sanitizeBrief, buildPrompt, cleanItin } from "../../site/planner.js";
import destinations from "../../site/data/destinations.json" with { type: "json" };
import legs from "../../site/data/legs.json" with { type: "json" };
import rules from "../../site/data/rules.json" with { type: "json" };
import gateways from "../../site/data/gateways.json" with { type: "json" };

const kb = { destinations, legs, rules, gateways };
const engine = new Engine(kb);
const MAX_BODY = 40_000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const originOk = allowed.includes(origin);
    const cors = originOk
      ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "origin" }
      : {};
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (url.pathname === "/health") return json(200, { ok: true, model: env.GEMINI_MODEL || null, keySet: Boolean(env.GEMINI_API_KEY) });
    if (url.pathname === "/selftest" || url.pathname === "/selftest/quick") {
      if (env.PLAN_LIMITER) {
        const { success } = await env.PLAN_LIMITER.limit({ key: "selftest:" + (request.headers.get("cf-connecting-ip") || "unknown") });
        if (!success) return json(429, { error: "rate_limited" });
      }
      return json(200, await selfTest(env, url.pathname.endsWith("/quick")));
    }
    if (url.pathname !== "/plan" || request.method !== "POST") return json(404, { error: "not_found" });
    if (!originOk) return json(403, { error: "origin_not_allowed" });
    if (!env.GEMINI_API_KEY) return json(500, { error: "not_configured" });

    if (env.PLAN_LIMITER) {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.PLAN_LIMITER.limit({ key: ip });
      if (!success) return json(429, { error: "rate_limited" });
    }

    const text = await request.text();
    if (text.length > MAX_BODY) return json(413, { error: "too_large" });
    let body;
    try { body = JSON.parse(text); } catch { return json(400, { error: "bad_json" }); }

    // Validate everything; nothing from the request reaches the prompt unchecked.
    const primaryId = String(body.primaryId || "");
    if (!engine.dest.has(primaryId)) return json(400, { error: "unknown_destination" });
    const brief = sanitizeBrief(body.brief, kb);
    let current, fixes, change;
    if (body.current) {
      try { current = cleanItin(engine, body.current, brief, "ai"); } catch { return json(400, { error: "bad_itinerary" }); }
      if (body.fix) fixes = current.warnings.filter((w) => w.severity === "block").map((w) => w.message);
    }
    if (body.change) change = String(body.change).replace(/[\u0000-\u001f]/g, " ").slice(0, 500);

    const prompt = buildPrompt({ engine, primaryId, brief, current, fixes, change });
    const g = await callGemini(env, prompt);
    if (g.status === 429) return json(429, { error: "rate_limited" });
    if (!g.ok) return json(503, { error: "upstream_error", status: g.status, detail: g.detail });

    const plan = parsePlan(g.text);
    if (!plan) return json(502, { error: "invalid_json", finishReason: g.finishReason });
    return json(200, { plan });
  },
};

/** One Gemini call. Returns {ok, status, text, finishReason, usage, detail}; never throws, never exposes the key. */
async function callGemini(env, prompt, { maxOutputTokens = 32768 } = {}) {
  const model = env.GEMINI_MODEL || "gemini-3.5-flash";
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // Room for the model's thinking as well as the plan: thinking models count both.
        generationConfig: { responseMimeType: "application/json", temperature: 0.7, maxOutputTokens },
      }),
    });
  } catch {
    return { ok: false, status: 0, detail: "Couldn't reach Gemini." };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = String(data?.error?.message || "").replace(/AIza[0-9A-Za-z_-]+/g, "[key]").slice(0, 300);
    return { ok: false, status: res.status, detail: msg || `Gemini returned ${res.status}.` };
  }
  const cand = data?.candidates?.[0];
  return {
    ok: true, status: res.status,
    text: cand?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || "").join("") || "",
    finishReason: cand?.finishReason || data?.promptFeedback?.blockReason || null,
    usage: data?.usageMetadata || null,
  };
}

/** GET /selftest runs a real sample plan and reports what happened (no plan content). */
async function selfTest(env, quick = false) {
  if (!env.GEMINI_API_KEY) return { ok: false, step: "key", detail: "GEMINI_API_KEY isn't set on this Worker." };
  const brief = sanitizeBrief({ origin: "New Delhi", originId: "delhi", startDate: "2026-11-14", days: 3, vibes: ["heritage"] }, kb);
  const t0 = Date.now();
  const prompt = quick
    ? 'Reply with only this JSON: {"days":[{"day":1,"baseId":"jaipur","stops":[{"name":"Amber Fort"}]}]}'
    : buildPrompt({ engine, primaryId: "jaipur", brief });
  const g = await callGemini(env, prompt);
  const base = { model: env.GEMINI_MODEL || "gemini-3.5-flash", ms: Date.now() - t0, status: g.status, finishReason: g.finishReason, usage: g.usage };
  if (!g.ok) return { ok: false, step: "gemini", detail: g.detail, ...base };
  const plan = parsePlan(g.text);
  if (!plan) return { ok: false, step: "parse", textLength: g.text.length, textStart: g.text.slice(0, 120), ...base };
  return { ok: true, step: "done", days: plan.days.length, ...base };
}

function parsePlan(text) {
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let v = tryParse(text);
  if (!v) { const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) v = tryParse(m[1]); }
  if (!v) { const a = text.indexOf("{"), b = text.lastIndexOf("}"); if (a >= 0 && b > a) v = tryParse(text.slice(a, b + 1)); }
  return v && Array.isArray(v.days) ? v : null;
}
