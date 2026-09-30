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
    if (url.pathname === "/health") return json(200, { ok: true, model: env.GEMINI_MODEL || null });
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
    const model = env.GEMINI_MODEL || "gemini-3.5-flash";
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.7, maxOutputTokens: 8192 },
      }),
    }).catch(() => null);

    if (!upstream) return json(503, { error: "upstream_unreachable" });
    if (upstream.status === 429) return json(429, { error: "rate_limited" });
    if (!upstream.ok) return json(503, { error: "upstream_error", status: upstream.status });

    const data = await upstream.json().catch(() => null);
    const out = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const plan = parsePlan(out);
    if (!plan) return json(502, { error: "invalid_json" });
    return json(200, { plan });
  },
};

function parsePlan(text) {
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let v = tryParse(text);
  if (!v) { const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) v = tryParse(m[1]); }
  if (!v) { const a = text.indexOf("{"), b = text.lastIndexOf("}"); if (a >= 0 && b > a) v = tryParse(text.slice(a, b + 1)); }
  return v && Array.isArray(v.days) ? v : null;
}
