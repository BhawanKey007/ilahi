// Golden tests for the ilAhi rules engine.
// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Engine } from "../site/engine.js";


const load = (f) => JSON.parse(readFileSync(new URL(`../site/data/${f}`, import.meta.url), "utf8"));
const engine = new Engine({
  destinations: load("destinations.json"),
  legs: load("legs.json"),
  rules: load("rules.json"),
  gateways: load("gateways.json"),
});

const brief = (over = {}) => ({
  origin: "delhi", days: 7, travellers: 2, group: "couple", budget: "midrange",
  vibes: ["heritage", "food"], nationality: "indian", ...over,
});

const itin = (days, b = {}) => ({
  id: "t", title: "t", summary: "", brief: brief({ days: days.length, ...b }), days,
  budget: { perPersonInr: 0, breakdown: { stay: 0, food: 0, transport: 0, activities: 0 } },
  warnings: [], generatedBy: "template",
});

const s = (name) => ({ name, blurb: "" });

// The trip shown in the design: starts Sat 14 Nov 2026, Taj on Mon 16 Nov.
const goldenTriangle = (start = "2026-11-14") => itin([
  { day: 1, baseId: "delhi", title: "Delhi", stops: [s("Humayun's Tomb"), s("Lodhi Garden"), s("Old Delhi food walk")] },
  { day: 2, baseId: "agra", title: "Agra", leg: { from: "delhi", to: "agra", mode: "train", durationHrs: 2, costInr: 1000 }, stops: [s("Agra Fort"), s("Mehtab Bagh")] },
  { day: 3, baseId: "jaipur", title: "Taj then Jaipur", leg: { from: "agra", to: "jaipur", mode: "cab", durationHrs: 5, costInr: 1500 }, stops: [s("Taj Mahal sunrise")] },
  { day: 4, baseId: "jaipur", title: "Jaipur", stops: [s("Amber Fort"), s("City Palace"), s("Hawa Mahal")] },
  { day: 5, baseId: "jaipur", title: "Jaipur", stops: [s("Nahargarh"), s("Johari Bazaar")] },
  { day: 6, baseId: "udaipur", title: "Udaipur", leg: { from: "jaipur", to: "udaipur", mode: "train", durationHrs: 7, costInr: 1200 }, stops: [s("Lake Pichola")] },
  { day: 7, baseId: "udaipur", title: "Udaipur", stops: [s("City Palace")] },
], { startDate: start });

const ids = (w) => w.map((x) => x.ruleId).filter(Boolean);

test("design trip: no blocking issues, winter smog noted", () => {
  const w = engine.check(goldenTriangle());
  assert.equal(w.filter((x) => x.severity === "block").length, 0, JSON.stringify(w, null, 1));
  assert.ok(ids(w).includes("delhi_smog"));
});

test("Taj visit on a travel day out of Agra is still checked", () => {
  const shifted = goldenTriangle("2026-11-18"); // day 3 = Fri 20 Nov, leaving Agra for Jaipur
  assert.ok(engine.check(shifted).some((x) => x.ruleId === "taj_friday" && x.severity === "block" && x.day === 3));
});

test("Taj on a Friday in Agra is blocked", () => {
  const t = itin([
    { day: 1, baseId: "agra", title: "Agra", stops: [s("Taj Mahal sunrise"), s("Agra Fort")] },
  ], { startDate: "2026-11-20" }); // Friday
  const w = engine.check(t);
  assert.ok(w.some((x) => x.ruleId === "taj_friday" && x.severity === "block"));
});

test("Leh: Khardung La on arrival day is blocked for altitude", () => {
  const t = itin([
    { day: 1, baseId: "leh", title: "Arrive", leg: { from: "delhi", to: "leh", mode: "flight", durationHrs: 1.5, costInr: 8000 }, stops: [s("Khardung La")] },
    { day: 2, baseId: "leh", title: "Rest", stops: [] },
  ], { startDate: "2026-07-10" });
  assert.ok(engine.check(t).some((x) => x.ruleId === "ams_acclimatise" && x.severity === "block"));
});

test("Leh: resting on arrival gives only an acclimatisation note", () => {
  const t = itin([
    { day: 1, baseId: "leh", title: "Arrive", leg: { from: "delhi", to: "leh", mode: "flight", durationHrs: 1.5, costInr: 8000 }, stops: [] },
    { day: 2, baseId: "leh", title: "Easy", stops: [s("Shanti Stupa")] },
    { day: 3, baseId: "leh", title: "Pass", stops: [s("Khardung La")] },
  ], { startDate: "2026-07-10" });
  const w = engine.check(t).filter((x) => x.ruleId === "ams_acclimatise");
  assert.equal(w.length, 1);
  assert.equal(w[0].severity, "info");
});

test("Manali → Leh by road in January is blocked", () => {
  const t = itin([
    { day: 1, baseId: "manali", title: "Manali", stops: [] },
    { day: 2, baseId: "leh", title: "Drive", leg: { from: "manali", to: "leh", mode: "cab", durationHrs: 16, costInr: 7000 }, stops: [] },
  ], { startDate: "2027-01-10" });
  const w = engine.check(t);
  assert.ok(w.some((x) => x.severity === "block" && /usually closed in Jan/.test(x.message)));
  assert.ok(ids(w).includes("manali_leh_seasonal"));
});

test("Tawang permits depend on nationality", () => {
  const days = [{ day: 1, baseId: "tawang", title: "Tawang", stops: [s("Tawang Monastery")] }];
  assert.ok(ids(engine.check(itin(days, { startDate: "2026-10-05", nationality: "indian" }))).includes("arunachal_ilp"));
  const foreign = ids(engine.check(itin(days, { startDate: "2026-10-05", nationality: "foreign" })));
  assert.ok(foreign.includes("arunachal_pap") && !foreign.includes("arunachal_ilp"));
});

test("unrealistic travel time is flagged", () => {
  const t = itin([
    { day: 1, baseId: "delhi", title: "Delhi", stops: [] },
    { day: 2, baseId: "manali", title: "Manali", leg: { from: "delhi", to: "manali", mode: "cab", durationHrs: 7, costInr: 4000 }, stops: [] },
  ], { startDate: "2026-10-10" });
  assert.ok(engine.check(t).some((x) => /realistically takes 12–14 h/.test(x.message)));
});

test("missing travel leg between cities is flagged", () => {
  const t = itin([
    { day: 1, baseId: "jaipur", title: "Jaipur", stops: [] },
    { day: 2, baseId: "udaipur", title: "Udaipur", stops: [] },
  ], { startDate: "2026-11-10" });
  assert.ok(engine.check(t).some((x) => /no travel leg/.test(x.message)));
});

test("Goa in July carries a season warning", () => {
  const t = itin([{ day: 1, baseId: "goa", title: "Goa", stops: [] }], { startDate: "2026-07-10", vibes: ["beach"] });
  assert.ok(engine.check(t).some((x) => /Goa in Jul/.test(x.message)));
});

test("elderly family is warned away from Spiti", () => {
  const t = itin([{ day: 1, baseId: "spiti", title: "Kaza", stops: [] }], { startDate: "2026-07-10", group: "family_elders" });
  assert.ok(engine.check(t).some((x) => /demanding for elderly/.test(x.message)));
});

test("November heritage + food suggestions match the design", () => {
  const out = engine.suggest(brief({ month: 11 }), 6);
  const top = out.map((x) => x.destination.id);
  assert.ok(top.includes("varanasi"), top.join(","));
  assert.ok(out.find((x) => x.destination.id === "varanasi").tags.includes("Festival this month"));
  assert.ok(!top.includes("leh"), "Leh is off-season in Nov and not heritage");
  for (const x of out) assert.ok(x.tags.includes("Peak season"));
});

test("monsoon suggestions never include avoid-month places", () => {
  const out = engine.suggest(brief({ month: 7, vibes: ["beach", "mountains"] }), 20);
  const top = out.map((x) => x.destination.id);
  for (const bad of ["goa", "andaman", "manali"]) assert.ok(!top.includes(bad), `${bad} in ${top}`);
  assert.ok(top.includes("leh"));
});

test("budget estimate is in a sensible range for the design trip", () => {
  const b = engine.estimateBudget(goldenTriangle());
  assert.ok(b.perPersonInr > 35000 && b.perPersonInr < 55000, String(b.perPersonInr));
  assert.equal(b.breakdown.transport, 3500);
});

test("seasonal leg options are split open vs closed", () => {
  const { open, closed } = engine.legOptions("manali", "leh", 1);
  assert.equal(open.length, 0);
  assert.equal(closed.length, 2);
});
