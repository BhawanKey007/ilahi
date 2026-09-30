// ilAhi web app. Rendering, events and the AI provider chain.
// Rules live in engine.js; prompts and AI-output cleaning live in planner.js.
import { Engine, MONTHS, MONTH_NAMES, withDates, monthOf, modeName } from "./engine.js";
import { sanitizeBrief, buildPrompt, cleanItin, templateItin } from "./planner.js";

const CONFIG = window.ILAHI_CONFIG || {};
const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* ================= App data ================= */
const REGION = {
  West: { c: "#A8284E", t: "#A8284E", label: "Rajasthan & the west" },
  North: { c: "#8A3B1F", t: "#A04A2A", label: "The Mughal north" },
  Himalaya: { c: "#2F5B8A", t: "#3A6CA3", label: "The Himalaya" },
  South: { c: "#2D6A4B", t: "#2F7A55", label: "The south" },
  East: { c: "#2E3A7A", t: "#4553A3", label: "The east" },
  Northeast: { c: "#9A2F24", t: "#B03A2E", label: "The northeast" },
  Islands: { c: "#1F6F72", t: "#23807F", label: "The islands" },
};
const ORIGINS = [
  ["New Delhi", "delhi"], ["Mumbai", ""], ["Bengaluru", ""], ["Chennai", "chennai"], ["Kolkata", ""], ["Hyderabad", ""],
  ["Pune", ""], ["Ahmedabad", ""], ["Jaipur", "jaipur"], ["Kochi", "kochi"], ["Guwahati", "guwahati"], ["Lucknow", ""],
  ["Chandigarh", ""], ["Goa", "goa"], ["Varanasi", "varanasi"],
];
const VIBE_LABELS = [["heritage", "Heritage"], ["food", "Food"], ["mountains", "Mountains"], ["spiritual", "Spiritual"], ["beach", "Beaches"], ["backwaters", "Backwaters"], ["desert", "Desert"], ["adventure", "Adventure"], ["offbeat", "Offbeat"], ["wildlife", "Wildlife"], ["nightlife", "Nightlife"]];
const GROUP_LABELS = [["solo", "Solo"], ["couple", "Couple"], ["friends", "Friends"], ["family_kids", "Family + kids"], ["family_elders", "Family + elders"]];
const TIER_LABELS = [["backpacker", "Backpacker", "₹1–2.5k"], ["midrange", "Mid-range", "₹4–8k"], ["premium", "Premium", "₹12k+"]];
const tierName = (v) => TIER_LABELS.find((t) => t[0] === v)?.[1] ?? v;

function defaultStart() {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() + 2, 14)).toISOString().slice(0, 10);
}

const state = {
  kb: null, engine: null, sample: null,
  view: "plan",
  form: { origin: "New Delhi", startDate: defaultStart(), days: 7, travellers: 2, group: "couple", budget: "midrange", vibes: ["heritage", "food"], nationality: "indian", notes: "" },
  suggestions: [], itin: null, tab: "timeline", busy: null, ctl: null, error: "", confirmDelete: null, fromTrips: false,
};

/* ================= Storage (per device, best-effort) ================= */
const store = {
  get() { try { return JSON.parse(localStorage.getItem("ilahi.trips") || "[]"); } catch { return []; } },
  set(v) { try { localStorage.setItem("ilahi.trips", JSON.stringify(v)); return true; } catch { return false; } },
};

/* ================= Helpers ================= */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
const $ = (s) => document.querySelector(s);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600);
}
function brief() {
  const f = state.form;
  const o = ORIGINS.find(([n]) => n.toLowerCase() === String(f.origin).trim().toLowerCase());
  return sanitizeBrief({ ...f, originId: o?.[1] || "" }, state.kb);
}
function fmtDate(iso) { if (!iso) return ""; const d = new Date(iso + "T00:00:00Z"); return d.getUTCDate() + " " + MONTHS[d.getUTCMonth() + 1]; }
function regionOf(id) { return REGION[state.engine.dest.get(id)?.region] || REGION.West; }
const shortMsg = (m) => { const s = m.replace(/^Day \d+:\s*/, ""); return s.length > 90 ? s.slice(0, 87) + "…" : s; };

/* ================= AI provider chain =================
   1. Inside Claude (published as a Claude artifact): the viewer's own Claude.
   2. On the public website: the ilAhi Worker (Gemini), if config.js sets plannerUrl.
   3. Neither: a starter plan from the knowledge base. */
let samplePromise = null;
function getSample() {
  if (!samplePromise) {
    samplePromise = Promise.resolve(window.claude?.use?.("sample")).catch(() => null).then((s) => {
      state.sample = s || null;
      if (state.view === "trip") render();
      return state.sample;
    });
  }
  return samplePromise;
}
async function hasAI() { return Boolean((await getSample()) || CONFIG.plannerUrl); }
function aiName() { return state.sample ? "Claude" : "ilAhi’s AI planner"; }

/** req: {primaryId, brief, current?, fix?, change?} → raw plan JSON */
async function askPlanner(req, signal) {
  const sample = await getSample();
  if (sample) {
    const fixes = req.fix ? state.engine.check(req.current).filter((w) => w.severity === "block").map((w) => w.message) : undefined;
    const prompt = buildPrompt({ engine: state.engine, primaryId: req.primaryId, brief: req.brief, current: req.current, fixes, change: req.change });
    return sample.json(prompt, { signal, ...(req.current ? { cache: false } : {}) });
  }
  if (CONFIG.plannerUrl) {
    let res;
    try {
      res = await fetch(CONFIG.plannerUrl.replace(/\/+$/, "") + "/plan", {
        method: "POST", headers: { "content-type": "application/json" }, signal,
        body: JSON.stringify({
          primaryId: req.primaryId, brief: req.brief, fix: Boolean(req.fix), change: req.change,
          current: req.current ? { title: req.current.title, summary: req.current.summary, days: req.current.days } : undefined,
        }),
      });
    } catch (e) {
      throw { code: e?.name === "AbortError" ? "cancelled" : "upstream_error", ref: e?.name === "AbortError" ? undefined : "network" };
    }
    if (res.status === 429) throw { code: "rate_limited" };
    if (!res.ok) {
      const info = await res.json().catch(() => ({}));
      throw { code: res.status === 502 ? "invalid_json" : "upstream_error", ref: (info.error || "http") + "-" + (info.status || res.status) };
    }
    const data = await res.json().catch(() => null);
    if (!data?.plan) throw { code: "invalid_json" };
    return data.plan;
  }
  throw { code: "no_provider" };
}

function errCopy(e) {
  const ref = " (ref: " + (e?.ref || e?.code || "unknown") + ")";
  return (({
    not_granted: "Claude wasn’t allowed for this page, so here’s a starter plan from ilAhi’s data instead.",
    sampling_disabled: "Claude isn’t available on this account, so here’s a starter plan from ilAhi’s data instead.",
    rate_limited: "The planner is busy right now. Here’s a starter plan; try again in a few minutes for a full one.",
    session_expired: "Your Claude session expired. Sign in again for a full plan; here’s a starter one meanwhile.",
    invalid_json: "The planner’s answer didn’t come through cleanly. Here’s a starter plan; tap the place again to retry.",
  })[e?.code] || "Couldn’t reach the planner just now. Here’s a starter plan from ilAhi’s data; try again in a bit.") + ref;
}

/* ================= Decorative regional motifs ================= */
function motif(region) {
  const w = "rgba(255,255,255,.14)", g = "#E0A23B", g2 = "#F6C66B";
  const dots = '<defs><pattern id="p' + region + '" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="1.8" fill="' + w + '"/></pattern></defs><rect width="200" height="260" fill="url(#p' + region + ')"/>';
  const art = {
    West: '<path d="M70 260V140Q70 64 135 40Q200 64 200 140V260Z" fill="rgba(0,0,0,.22)"/><path d="M92 260V150Q92 94 135 76Q178 94 178 150V260Z" fill="' + g + '"/><path d="M112 260V162Q112 124 135 112Q158 124 158 162V260Z" fill="' + g2 + '"/><circle cx="135" cy="26" r="6" fill="' + g + '"/>',
    North: '<rect x="70" y="170" width="130" height="90" fill="rgba(0,0,0,.2)"/><path d="M84 170Q84 104 135 88Q186 104 186 170Z" fill="' + g + '"/><rect x="132" y="66" width="6" height="24" fill="' + g2 + '"/><rect x="60" y="120" width="10" height="140" fill="' + g2 + '"/><rect x="200" y="120" width="10" height="140" fill="' + g2 + '"/><path d="M100 260V200Q100 184 115 180Q130 184 130 200V260Z" fill="' + g2 + '"/><path d="M140 260V200Q140 184 155 180Q170 184 170 200V260Z" fill="' + g2 + '"/>',
    Himalaya: '<path d="M20 260L95 120L140 190L175 140L230 260Z" fill="rgba(0,0,0,.22)"/><path d="M95 120L112 152L100 146L88 158L80 148Z" fill="#fff"/><path d="M60 260L135 150L200 260Z" fill="' + g + '"/><path d="M135 150L150 172L136 166L122 176Z" fill="#fff"/><g stroke="' + g2 + '" stroke-width="2"><path d="M40 60L180 90"/></g><g fill="' + g2 + '"><rect x="55" y="62" width="10" height="14"/><rect x="85" y="68" width="10" height="14" fill="#fff"/><rect x="115" y="75" width="10" height="14"/><rect x="145" y="81" width="10" height="14" fill="#fff"/></g>',
    South: '<rect y="12" width="200" height="4" fill="' + g + '"/><rect y="20" width="200" height="2" fill="' + g + '"/><path d="M100 260V228H190V260Z" fill="' + g + '"/><path d="M110 228V204H180V228Z" fill="' + g2 + '"/><path d="M120 204V184H170V204Z" fill="' + g + '"/><path d="M130 184V168H160V184Z" fill="' + g2 + '"/><path d="M137 168L145 150L153 168Z" fill="#fff"/><circle cx="40" cy="244" r="34" fill="rgba(0,0,0,.2)"/><circle cx="84" cy="252" r="22" fill="rgba(0,0,0,.14)"/>',
    East: '<circle cx="150" cy="60" r="18" fill="' + g2 + '"/><g fill="none" stroke="' + g + '" stroke-width="6" stroke-linecap="round"><path d="M40 200Q120 170 200 200"/><path d="M30 225Q120 195 210 225"/><path d="M20 250Q120 220 220 250"/></g><path d="M0 260V230Q60 200 120 232T220 226V260Z" fill="rgba(0,0,0,.18)"/>',
    Northeast: '<g fill="' + g + '">' + [0, 1, 2, 3, 4].map((i) => '<path d="M' + (90 + i * 24) + ' 200l12-14 12 14-12 14z"/>').join("") + '</g><g fill="' + g2 + '">' + [0, 1, 2, 3].map((i) => '<path d="M' + (102 + i * 24) + ' 228l12-14 12 14-12 14z"/>').join("") + '</g><rect x="70" y="170" width="140" height="4" fill="#fff" fill-opacity=".6"/><rect x="70" y="250" width="140" height="4" fill="#fff" fill-opacity=".6"/>',
    Islands: '<circle cx="150" cy="80" r="24" fill="' + g2 + '"/><g fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="4" stroke-linecap="round"><path d="M40 200q15-10 30 0t30 0 30 0 30 0 30 0"/><path d="M20 226q15-10 30 0t30 0 30 0 30 0 30 0 30 0"/></g><path d="M0 260V240Q100 222 220 244V260Z" fill="' + g + '"/>',
  }[region] || "";
  return '<svg class="motif" viewBox="0 0 200 260" preserveAspectRatio="xMaxYMax slice" aria-hidden="true">' + dots + art + "</svg>";
}
const TORAN = '<svg class="toran" viewBox="0 0 390 12" preserveAspectRatio="none" aria-hidden="true"><defs><pattern id="tor" width="26" height="12" patternUnits="userSpaceOnUse"><rect width="26" height="12" fill="#7E1D3A"/><path d="M0 0L13 12L26 0Z" fill="#E0A23B"/><circle cx="13" cy="3" r="2.2" fill="#FFFFFF"/></pattern></defs><rect width="390" height="12" fill="url(#tor)"/></svg>';
const BUTI = '<svg class="pattern" aria-hidden="true"><defs><pattern id="buti" width="30" height="30" patternUnits="userSpaceOnUse"><circle cx="15" cy="15" r="2.2" fill="#fff" fill-opacity=".16"/><circle cx="15" cy="9" r="1.6" fill="#fff" fill-opacity=".12"/><circle cx="15" cy="21" r="1.6" fill="#fff" fill-opacity=".12"/><circle cx="9" cy="15" r="1.6" fill="#fff" fill-opacity=".12"/><circle cx="21" cy="15" r="1.6" fill="#fff" fill-opacity=".12"/></pattern></defs><rect width="100%" height="100%" fill="url(#buti)"/></svg>';
const BACK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
const MODE_ICON = {
  train: '<path d="M7 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM4 10h16M8 17l-2 4M16 17l2 4"/>',
  flight: '<path d="M10.5 3.5l1.5 6.5 7 2v2l-7-1-1 5 2 2v1l-3.5-1-3.5 1v-1l2-2-1-5-7 1v-2l7-2 1.5-6.5z"/>',
  bus: '<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M7 18v3M17 18v3"/>',
  cab: '<path d="M5 16V11l2-5h10l2 5v5zM3 16h18M7 19v-3M17 19v-3M5 11h14"/>',
  ferry: '<path d="M3 16l2 4h14l2-4zM6 16V9h12v7M12 4v5"/>',
};
MODE_ICON.toy_train = MODE_ICON.train;
const legIcon = (m) => '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (MODE_ICON[m] || MODE_ICON.cab) + "</svg>";
const FOOT = '<p class="foot">Plans are guidance. Confirm permits, timings and bookings with official sources. <button type="button" data-go="about">Privacy and sources</button></p>';

/* ================= Views ================= */
function render() {
  $("#nav-plan").setAttribute("aria-current", ["trips", "about"].includes(state.view) ? "false" : "page");
  $("#nav-trips").setAttribute("aria-current", state.view === "trips" ? "page" : "false");
  $("#nav-about").setAttribute("aria-current", state.view === "about" ? "page" : "false");
  if (!state.kb) return;
  const views = { plan: viewPlan, suggest: viewSuggest, planning: viewPlanning, trip: viewTrip, trips: viewTrips, about: viewAbout };
  $("#app").innerHTML = views[state.view]();
  bind();
  window.scrollTo({ top: 0 });
}

function viewPlan() {
  const f = state.form;
  return '<header class="hero">' + BUTI + TORAN +
    '<div class="hero-inner"><div class="row" style="justify-content:space-between"><div class="logo">ilAhi</div><span class="chip-ghost" style="display:inline-flex;align-items:center" lang="hi">इलाही</span></div>' +
    '<div class="tagline">Book the trip you keep postponing. We’ll plan it in a minute.</div>' +
    "<h1>Where is India calling you?</h1></div></header>" +
    '<form class="card-float" id="brief" novalidate>' +
      '<div class="grid2">' +
        '<label class="field"><span>Starting from</span><input id="f-origin" list="origins" value="' + esc(f.origin) + '" autocomplete="off"></label>' +
        '<label class="field"><span>Start date</span><input id="f-date" type="date" value="' + esc(f.startDate) + '"></label>' +
        '<label class="field"><span>Days</span><input id="f-days" type="number" inputmode="numeric" min="1" max="21" value="' + esc(f.days) + '"></label>' +
        '<label class="field"><span>Travellers</span><input id="f-trav" type="number" inputmode="numeric" min="1" max="30" value="' + esc(f.travellers) + '"></label>' +
      '</div><datalist id="origins">' + ORIGINS.map(([n]) => '<option value="' + n + '">').join("") + "</datalist>" +
      '<div class="stack" style="gap:6px"><div class="label" id="l-group">Who’s going</div><div class="seg" role="group" aria-labelledby="l-group">' +
        GROUP_LABELS.map(([v, l]) => '<button type="button" class="pill" data-group="' + v + '" aria-pressed="' + (f.group === v) + '">' + l + "</button>").join("") + "</div></div>" +
      '<div class="stack" style="gap:6px"><div class="label" id="l-tier">Budget per person / day</div><div class="grid2" style="grid-template-columns:repeat(3,minmax(0,1fr))" role="group" aria-labelledby="l-tier">' +
        TIER_LABELS.map(([v, l, r]) => '<button type="button" class="tier" data-tier="' + v + '" aria-pressed="' + (f.budget === v) + '"><b>' + l + "</b><small>" + r + "</small></button>").join("") + "</div></div>" +
      '<div class="stack" style="gap:6px"><div class="label" id="l-vibe">What moves you</div><div class="seg" role="group" aria-labelledby="l-vibe">' +
        VIBE_LABELS.map(([v, l]) => '<button type="button" class="pill" data-vibe="' + v + '" aria-pressed="' + f.vibes.includes(v) + '">' + l + "</button>").join("") + "</div></div>" +
      '<div class="stack" style="gap:6px"><div class="label" id="l-nat">Passport</div><div class="seg" role="group" aria-labelledby="l-nat">' +
        '<button type="button" class="pill" data-nat="indian" aria-pressed="' + (f.nationality === "indian") + '">Indian</button><button type="button" class="pill" data-nat="foreign" aria-pressed="' + (f.nationality === "foreign") + '">Other country</button></div></div>' +
      '<label class="field"><span>Anything we should know? (optional)</span><textarea id="f-notes" rows="2" maxlength="300" placeholder="Vegetarian, elderly parent, no early mornings…">' + esc(f.notes) + "</textarea></label>" +
      '<button class="cta" type="submit">Show me where to go<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E0A23B" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>' +
      '<p class="note" style="margin:0">Checks seasons, permits and real travel times</p>' +
    "</form>" + FOOT;
}

function destCard(s, big) {
  const d = s.destination, r = REGION[d.region] || REGION.West;
  const tags = s.tags.slice(0, big ? 2 : 1);
  const why = s.festival ? s.festival.message.split(". ")[0] + "." : (d.notes || d.highlights.slice(0, big ? 3 : 2).join(" · "));
  const cost = d.dailyCostInr[state.form.budget];
  return '<button class="dest ' + (big ? "big" : "small") + '" style="--c:' + r.c + '" data-dest="' + d.id + '">' + motif(d.region) +
    '<span class="in"><span class="row" style="gap:6px;flex-wrap:wrap">' + tags.map((t) => '<span class="tag">' + esc(t) + "</span>").join("") + "</span>" +
    '<span class="kicker">' + esc(r.label) + '</span><span class="h">' + esc(d.name) + '</span><span class="why">' + esc(why) + "</span>" +
    '<span class="row" style="gap:6px;flex-wrap:wrap;margin-top:4px"><span class="tag dark">' + d.idealDays[0] + "–" + d.idealDays[1] + ' days</span><span class="tag dark">' + inr(cost[0]) + "–" + cost[1] / 1000 + "k/day</span></span>" +
    '<span class="go">' + (big ? "Build this trip" : "Plan this") + "</span></span></button>";
}

function viewSuggest() {
  const b = brief(), s = state.suggestions;
  const head = '<div class="topbar"><button class="iconbtn" data-go="plan" aria-label="Back to trip details">' + BACK + '</button><span class="muted" style="font-size:14px">' +
    esc(MONTHS[b.month] || "") + " · " + b.days + " days · " + b.travellers + (b.travellers > 1 ? " people" : " person") + " · " + esc(tierName(b.budget)) + "</span></div>" +
    '<div class="page-head"><h1>Made for your ' + esc(MONTH_NAMES[b.month] || "trip") + '</h1><p class="muted" style="margin:0">' +
    esc(b.vibes.length ? VIBE_LABELS.filter(([v]) => b.vibes.includes(v)).map(([, l]) => l).join(", ") : "Anything goes") + ", each in its best season.</p></div>";
  if (!s.length) return head + '<div class="empty"><h2 style="font-size:22px">Nothing fits all of that</h2><p class="muted" style="margin:0">Try more days, another month, or a different mix of interests.</p><button class="btn primary" data-go="plan">Change trip details</button></div>';
  return head + '<div class="wrap stack" style="gap:12px;padding-block:14px">' + destCard(s[0], true) +
    (s.length > 1 ? '<div class="cards-grid">' + s.slice(1, 5).map((x) => destCard(x, false)).join("") + "</div>" : "") +
    '<p class="note" style="margin:4px 0 0">Tap a place and ilAhi builds a day-by-day plan around it, adding nearby stops if your days allow.</p></div>';
}

function viewPlanning() {
  const steps = ["Choosing the route", "Timing trains and roads", "Checking seasons, permits and closures", "Adding places to eat and see"];
  const on = state.busy?.step ?? 0;
  return '<div class="loader" role="status" aria-live="polite">' +
    '<svg class="spinner" viewBox="0 0 64 64" aria-hidden="true"><g>' + Array.from({ length: 8 }, (_, i) => { const a = i * Math.PI / 4; return '<circle cx="' + (32 + 22 * Math.cos(a)).toFixed(1) + '" cy="' + (32 + 22 * Math.sin(a)).toFixed(1) + '" r="' + (3 + (i % 2) * 2) + '" opacity="' + (0.35 + i * 0.08).toFixed(2) + '"/>'; }).join("") + '<circle cx="32" cy="32" r="7" fill="#E0A23B"/></g></svg>' +
    '<h2 style="font-size:22px">' + esc(state.busy?.title || "Planning your trip") + "</h2>" +
    '<ul class="steps">' + steps.map((t, i) => '<li class="' + (i <= on ? "on" : "") + '">' + (i < on ? "✓ " : i === on ? "• " : "   ") + t + "</li>").join("") + "</ul>" +
    '<p class="note" style="margin:0">' + esc(aiName()) + " writes the plan, usually in under a minute." + (state.sample ? " The first time, Claude asks your permission." : "") + "</p>" +
    '<button class="btn" id="stop">Stop</button></div>';
}

function viewTrip() {
  const it = state.itin, e = state.engine, b = it.brief;
  const days = withDates(it.days, b.startDate);
  const r = regionOf(days[0]?.baseId);
  const warnings = it.warnings || [];
  const flagged = warnings.filter((w) => w.severity !== "info").length;
  const budget = e.estimateBudget(it);
  const last = days[days.length - 1];
  let body = "";
  if (state.tab === "timeline") {
    body = days.map((d) => {
      const rr = regionOf(d.baseId), dname = e.name(d.baseId), dt = d.date ? new Date(d.date + "T00:00:00Z") : null;
      const dayW = warnings.filter((w) => w.day === d.day && w.severity !== "info");
      const leg = d.leg ? '<div class="leg">' + legIcon(d.leg.mode) + "<div><b>" + esc(cap(modeName(d.leg.mode))) + " · " + esc(e.name(d.leg.from)) + " → " + esc(e.name(d.leg.to)) + "</b>" +
        esc([d.leg.departTime && "Leave " + d.leg.departTime, d.leg.durationHrs && "about " + d.leg.durationHrs + " h", d.leg.costInr && inr(d.leg.costInr) + " pp"].filter(Boolean).join(" · ")) +
        (d.leg.bookingTip ? '<div style="opacity:.9">' + esc(d.leg.bookingTip) + "</div>" : "") + "</div></div>" : "";
      return leg + '<article class="day" style="--dc:' + rr.c + ";--dct:" + rr.t + '"><div class="badge">' + (dt ? "<small>" + DOW[dt.getUTCDay()] + "</small><b>" + dt.getUTCDate() + "</b>" : "<b>" + d.day + "</b>") + "</div>" +
        '<div style="min-width:0"><div class="where">Day ' + d.day + " · " + esc(dname) + "</div><h3>" + esc(d.title || dname) + "</h3>" +
        '<ul class="stops">' + d.stops.map((s) => '<li><span class="t">' + esc(s.time || "") + '</span><span><span class="n">' + esc(s.name) + "</span>" + (s.blurb ? '<br><span class="b">' + esc(s.blurb) + "</span>" : "") + "</span></li>").join("") + "</ul>" +
        dayW.map((w) => '<span class="flag sev-' + w.severity + '">' + esc(shortMsg(w.message)) + "</span>").join(" ") + "</div></article>";
    }).join("");
  } else if (state.tab === "checks") {
    const ok = checksPassed(it, days);
    body = warnings.map((w) => checkRow(w.severity, w.message)).join("") + ok.map((m) => checkRow("ok", m)).join("") +
      (!warnings.length && !ok.length ? checkRow("ok", "No issues found for these dates.") : "") +
      '<p class="note" style="margin:4px 0 0">Permit and seasonal details change. Confirm with official sources before booking.</p>';
  } else {
    const trav = b.travellers;
    body = '<section class="panel stack" style="gap:10px"><div class="row" style="justify-content:space-between;align-items:baseline"><h2 style="font-size:20px">Estimated budget</h2><span class="muted" style="font-size:13px">per person</span></div>' +
      '<div class="money">' + inr(budget.perPersonInr) + "</div>" +
      (trav > 1 ? '<div class="muted">' + inr(budget.perPersonInr * trav) + " for " + trav + " travellers</div>" : "") +
      '<div class="stack">' + [["Stays · " + Math.max(1, days.length - 1) + " nights", budget.breakdown.stay], ["Food", budget.breakdown.food], ["Travel between cities", budget.breakdown.transport], ["Entry tickets and experiences", budget.breakdown.activities]]
        .map(([l, v]) => '<div class="line-item"><span>' + l + "</span><b>" + inr(v) + "</b></div>").join("") + "</div>" +
      '<p class="note" style="margin:0;text-align:left">Ranges from ilAhi’s route data for a ' + esc(tierName(b.budget).toLowerCase()) + " trip. Getting home from " + esc(e.name(last.baseId)) + " isn’t included.</p></section>";
  }
  const saved = store.get().some((t) => t.id === it.id);
  const canTweak = Boolean(state.sample || CONFIG.plannerUrl);
  return '<header class="trip-head" style="--c:' + r.c + '">' + motif(e.dest.get(days[0]?.baseId)?.region || "West") +
    '<div class="topbar" style="position:relative"><button class="iconbtn" data-go="' + (state.fromTrips ? "trips" : "suggest") + '" aria-label="Back">' + BACK + "</button></div>" +
    '<div class="in"><h1>' + esc(it.title) + '</h1><div style="font-size:14px;opacity:.92">' + esc(fmtDate(days[0]?.date) + " – " + fmtDate(last?.date)) + " · " + b.travellers + (b.travellers > 1 ? " travellers" : " traveller") + " · " + esc(tierName(b.budget)) + "</div>" +
    (it.summary ? '<div style="font-size:15px;max-width:78%">' + esc(it.summary) + "</div>" : "") +
    (it.generatedBy === "template" ? '<span class="srcpill">Starter plan</span>' : "") +
    '<div class="tabs" role="tablist">' + [["timeline", "Days"], ["checks", "Checks" + (flagged ? " (" + flagged + ")" : "")], ["budget", "Budget"]]
      .map(([k, l]) => '<button class="tab" role="tab" data-tab="' + k + '" aria-selected="' + (state.tab === k) + '">' + l + "</button>").join("") + "</div></div></header>" +
    '<div class="wrap stack" style="gap:12px;padding-block:14px">' + body + "</div>" +
    '<div class="wrap stack" style="gap:10px;padding-block:6px 16px">' +
      (canTweak ? '<form class="chatbox" id="tweak"><textarea id="f-tweak" rows="1" maxlength="500" aria-label="Ask for a change" placeholder="Make day 3 lighter, add a food walk…"></textarea><button class="btn primary" type="submit">Change</button></form>' : "") +
      (state.error ? '<p class="flag sev-warn" role="alert" style="margin:0">' + esc(state.error) + "</p>" : "") +
      '<div class="grid2"><button class="btn primary" id="save">' + (saved ? "Saved ✓" : "Save trip") + '</button><a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(shareText(it)) + '">Share on WhatsApp</a></div>' +
      '<button class="btn" id="copy">Copy plan as text</button><textarea id="copy-fallback" hidden readonly rows="6" class="field" aria-label="Plan text"></textarea>' +
    "</div>" + FOOT;
}
function checkRow(sev, msg) {
  const icon = { ok: '<path d="M5 12.5l4.5 4.5L19 7"/>', block: '<path d="M6 6l12 12M18 6L6 18"/>', warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.5"/>', info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8v.5"/>' }[sev];
  return '<div class="check sev-' + sev + '"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icon + '</svg></span><span style="font-size:15px">' + esc(msg) + "</span></div>";
}
function checksPassed(it, days) {
  const out = [], e = state.engine;
  for (const d of days) {
    const inAgra = d.baseId === "agra" || d.leg?.from === "agra";
    if (inAgra && d.date && d.stops.some((s) => /taj mahal/i.test(s.name))) {
      const wd = new Date(d.date + "T00:00:00Z").getUTCDay();
      if (wd !== 5) out.push("Taj Mahal visit falls on a " + WEEKDAY[wd] + ". It’s closed on Fridays.");
    }
  }
  const m = monthOf(it.brief.startDate);
  const inSeason = [...new Set(days.map((d) => d.baseId))].map((id) => e.dest.get(id)).filter((d) => d && m && d.bestMonths.includes(m)).map((d) => d.name);
  if (inSeason.length) out.push(inSeason.join(", ") + (inSeason.length > 1 ? " are" : " is") + " in peak season in " + MONTHS[m] + ".");
  return [...new Set(out)];
}
function shareText(it) {
  const e = state.engine, days = withDates(it.days, it.brief.startDate);
  return "ilAhi trip: " + it.title + "\n" + days.map((d) => "Day " + d.day + (d.date ? " (" + fmtDate(d.date) + ")" : "") + " · " + e.name(d.baseId) + ": " +
    (d.leg ? modeName(d.leg.mode) + " from " + e.name(d.leg.from) + ". " : "") + d.stops.map((s) => s.name).join(", ")).join("\n");
}

function viewTrips() {
  const trips = store.get();
  if (!trips.length) return '<div class="page-head" style="padding-top:20px"><h1>My trips</h1></div><div class="empty"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:var(--accent-ink)"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg><h2 style="font-size:22px">No saved trips yet</h2><p class="muted" style="margin:0">Plans you save appear here, on this device.</p><button class="btn primary" data-go="plan">Plan a trip</button></div>';
  return '<div class="page-head" style="padding-top:20px"><h1>My trips</h1><p class="muted" style="margin:0">Saved on this device.</p></div><div class="wrap stack" style="gap:10px;padding-block:14px">' +
    trips.map((t) => {
      const r = regionOf(t.itin.days[0]?.baseId);
      const confirming = state.confirmDelete === t.id;
      return '<div class="trip-row"><span class="swatch" style="--c:' + r.c + '"></span><button class="stack" data-open="' + esc(t.id) + '" style="flex:1;min-width:0;text-align:left;border:none;background:none;padding:0"><b style="font-size:16px">' + esc(t.itin.title) + '</b><span class="muted" style="font-size:14px">' + esc(fmtDate(t.itin.brief.startDate)) + " · " + t.itin.days.length + " days</span></button>" +
        (confirming
          ? '<button class="btn" data-del-yes="' + esc(t.id) + '" style="min-height:40px;padding:0 12px">Delete</button><button class="btn" data-del-no style="min-height:40px;padding:0 12px">Keep</button>'
          : '<button class="iconbtn" data-del="' + esc(t.id) + '" aria-label="Delete ' + esc(t.itin.title) + '"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>') + "</div>";
    }).join("") + "</div>";
}

function viewAbout() {
  const kb = state.kb;
  const aiLine = state.sample
    ? "Inside Claude, day-by-day plans are written by your own Claude account. ilAhi sends Claude your trip details and the relevant travel data."
    : CONFIG.plannerUrl
      ? "Day-by-day plans are written by Google’s Gemini through ilAhi’s planner. Your trip details (dates, city, group type, budget, interests and any notes you type) are sent to Google to write the plan. On Gemini’s free tier, Google may use this to improve its products, so don’t put personal details in the notes."
      : "This copy of ilAhi has no AI planner connected, so it builds starter plans from its own travel data. Nothing you type leaves your device.";
  return '<div class="prose"><h1 style="font-size:27px">About ilAhi</h1>' +
    "<p>ilAhi plans India trips that work on the ground: the right season, realistic train and road times, permits you’ll need and closure days to avoid.</p>" +
    "<h2>How your plan is made</h2><ul>" +
      "<li>Suggestions, checks and budgets are worked out on your device from ilAhi’s travel data: " + kb.destinations.length + " destinations, " + kb.legs.length + " routes and " + kb.rules.length + " local rules.</li>" +
      "<li>" + esc(aiLine) + "</li>" +
      "<li>Every plan is checked against the rules before you see it. If it breaks one, the planner is asked to fix it.</li></ul>" +
    "<h2>Your data</h2><ul><li>Saved trips stay in this browser on this device. ilAhi has no accounts and no database.</li><li>ilAhi doesn’t use cookies or analytics.</li></ul>" +
    "<h2>Please double-check</h2><p>Travel times, prices, permits and seasonal closures change. Treat plans as guidance and confirm with official sources and operators before you book.</p>" +
    '<h2>Open source</h2><p>ilAhi is open source. Spotted wrong travel information? <a href="https://github.com/BhawanKey007/ilahi/issues/new?template=wrong-info.yml" target="_blank" rel="noopener">Report it on GitHub</a>.</p></div>';
}

/* ================= Events ================= */
function bind() {
  document.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => { state.view = el.dataset.go; state.error = ""; render(); }));
  const form = $("#brief");
  if (form) {
    const sync = () => {
      const f = state.form;
      f.origin = $("#f-origin").value; f.startDate = $("#f-date").value || f.startDate;
      f.days = $("#f-days").value; f.travellers = $("#f-trav").value; f.notes = $("#f-notes").value;
    };
    form.addEventListener("input", sync);
    const pick = (attr, key) => form.querySelectorAll("[data-" + attr + "]").forEach((el) => el.addEventListener("click", () => { sync(); state.form[key] = el.dataset[attr]; render(); }));
    pick("group", "group"); pick("tier", "budget"); pick("nat", "nationality");
    form.querySelectorAll("[data-vibe]").forEach((el) => el.addEventListener("click", () => {
      sync();
      const v = el.dataset.vibe, vs = state.form.vibes;
      state.form.vibes = vs.includes(v) ? vs.filter((x) => x !== v) : [...vs, v];
      render();
    }));
    form.addEventListener("submit", (ev) => {
      ev.preventDefault(); sync();
      const b = brief();
      state.form.days = b.days; state.form.travellers = b.travellers;
      state.suggestions = state.engine.suggest(b, 5);
      state.view = "suggest"; render();
    });
  }
  document.querySelectorAll("[data-dest]").forEach((el) => el.addEventListener("click", () => buildTrip(el.dataset.dest)));
  document.querySelectorAll("[data-tab]").forEach((el) => el.addEventListener("click", () => { state.tab = el.dataset.tab; render(); }));
  $("#stop")?.addEventListener("click", () => state.ctl?.abort());
  $("#save")?.addEventListener("click", () => {
    const trips = store.get().filter((t) => t.id !== state.itin.id);
    trips.unshift({ id: state.itin.id, savedAt: Date.now(), itin: state.itin });
    toast(store.set(trips.slice(0, 30)) ? "Saved to My trips" : "Couldn’t save on this device");
    render();
  });
  $("#copy")?.addEventListener("click", async () => {
    const text = shareText(state.itin);
    try { await navigator.clipboard.writeText(text); toast("Plan copied"); }
    catch { const ta = $("#copy-fallback"); ta.hidden = false; ta.value = text; ta.focus(); ta.select(); toast("Select and copy the text below"); }
  });
  $("#tweak")?.addEventListener("submit", (ev) => { ev.preventDefault(); const v = $("#f-tweak").value.trim(); if (v) tweakTrip(v); });
  document.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => {
    const t = store.get().find((x) => x.id === el.dataset.open);
    if (!t) return;
    state.itin = t.itin; state.tab = "timeline"; state.fromTrips = true; state.error = ""; state.view = "trip"; render();
  }));
  document.querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", () => { state.confirmDelete = el.dataset.del; render(); }));
  document.querySelectorAll("[data-del-yes]").forEach((el) => el.addEventListener("click", () => {
    store.set(store.get().filter((t) => t.id !== el.dataset.delYes));
    state.confirmDelete = null; toast("Trip deleted"); render();
  }));
  document.querySelectorAll("[data-del-no]").forEach((el) => el.addEventListener("click", () => { state.confirmDelete = null; render(); }));
}
$("#nav-plan").addEventListener("click", () => { state.view = "plan"; state.fromTrips = false; state.error = ""; render(); });
$("#nav-trips").addEventListener("click", () => { state.view = "trips"; state.confirmDelete = null; render(); });
$("#nav-about").addEventListener("click", () => { state.view = "about"; render(); });

/* ================= Planning ================= */
function startBusy(title, step) {
  state.ctl = new AbortController();
  state.busy = { title, step };
  state.view = "planning"; render();
  const tick = setInterval(() => {
    if (state.busy && state.busy.step < 3) { state.busy.step++; if (state.view === "planning") render(); }
  }, 9000);
  return () => clearInterval(tick);
}

async function buildTrip(primaryId) {
  const b = brief();
  state.fromTrips = false; state.tab = "timeline"; state.error = "";
  if (!(await hasAI())) {
    state.itin = templateItin(state.engine, primaryId, b);
    state.view = "trip"; render(); return;
  }
  const stop = startBusy("Planning " + state.engine.name(primaryId), 0);
  try {
    let itin = cleanItin(state.engine, await askPlanner({ primaryId, brief: b }, state.ctl.signal), b, "ai");
    if (itin.warnings.some((w) => w.severity === "block")) {
      state.busy = { title: "Fixing a few things", step: 2 }; render();
      try {
        itin = cleanItin(state.engine, await askPlanner({ primaryId, brief: b, current: itin, fix: true }, state.ctl.signal), b, "ai");
      } catch (e) {
        if (e?.code === "cancelled") throw e;
        // Keep the first plan; its problems are listed on the Checks tab.
      }
    }
    state.itin = itin;
  } catch (e) {
    if (e?.code === "cancelled") { stop(); state.busy = null; state.view = "suggest"; render(); return; }
    state.itin = templateItin(state.engine, primaryId, b);
    state.error = errCopy(e);
  } finally { stop(); }
  state.busy = null; state.view = "trip"; render();
}

async function tweakTrip(request) {
  const it = state.itin, b = it.brief, primaryId = it.days[0]?.baseId;
  if (!(await hasAI()) || !state.engine.dest.has(primaryId)) return;
  state.error = "";
  const stop = startBusy("Updating your plan", 1);
  try {
    const raw = await askPlanner({ primaryId, brief: b, current: it, change: request.slice(0, 500) }, state.ctl.signal);
    state.itin = cleanItin(state.engine, raw, b, "ai", it.id);
    toast("Plan updated");
  } catch (e) {
    if (e?.code !== "cancelled") state.error = e?.code === "rate_limited" ? "The planner is busy right now. Try the change again in a few minutes." : "That change didn’t go through. Try rewording it.";
  } finally { stop(); }
  state.busy = null; state.view = "trip"; render();
}

/* ================= Boot ================= */
(async function boot() {
  try {
    const files = ["destinations", "legs", "rules", "gateways"];
    const [destinations, legs, rules, gateways] = await Promise.all(files.map((f) =>
      fetch("data/" + f + ".json").then((r) => { if (!r.ok) throw new Error(f); return r.json(); })));
    state.kb = { destinations, legs, rules, gateways };
    state.engine = new Engine(state.kb);
    render();
    getSample();
  } catch {
    $("#app").innerHTML = '<div class="empty"><h2 style="font-size:22px">ilAhi couldn’t load its travel data</h2><p class="muted">Reload the page to try again.</p></div>';
  }
})();
