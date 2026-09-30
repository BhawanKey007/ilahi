// Checks the travel data files for broken links and contradictions.
// Run: npm run validate   (CI runs it on every push and pull request)
import { readFileSync } from "node:fs";

const load = (f) => JSON.parse(readFileSync(new URL(`../site/data/${f}.json`, import.meta.url), "utf8"));
const errors = [];
const err = (m) => errors.push(m);

let d, l, r, g;
try {
  d = load("destinations"); l = load("legs"); r = load("rules"); g = load("gateways");
} catch (e) {
  console.error("✗ A data file isn't valid JSON:", e.message);
  process.exit(1);
}

const REGIONS = ["North", "Himalaya", "West", "South", "East", "Northeast", "Islands"];
const MODES = ["train", "flight", "bus", "cab", "ferry", "toy_train"];
const TIERS = ["backpacker", "midrange", "premium"];
const TRIGGERS = ["visit", "stop", "road_arrival", "altitude"];
const isMonth = (m) => Number.isInteger(m) && m >= 1 && m <= 12;
const range = (x) => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite) && x[0] <= x[1];

const dup = (list, what) => {
  const seen = new Set();
  for (const x of list) { if (seen.has(x.id)) err(`duplicate ${what} id "${x.id}"`); seen.add(x.id); }
  return seen;
};
const dids = dup(d, "destination"), gids = dup(g, "gateway"), rids = dup(r, "rule");
dup(l, "leg");
for (const id of dids) if (gids.has(id)) err(`"${id}" is both a destination and a gateway`);

for (const x of d) {
  const at = `destination ${x.id}`;
  if (!REGIONS.includes(x.region)) err(`${at}: unknown region "${x.region}"`);
  if (!x.bestMonths.every(isMonth)) err(`${at}: bestMonths must be 1–12`);
  for (const a of x.avoidMonths) {
    if (!a.months.every(isMonth)) err(`${at}: avoidMonths must be 1–12`);
    if (!a.reason) err(`${at}: avoidMonths entry needs a reason`);
    for (const m of a.months) if (x.bestMonths.includes(m)) err(`${at}: month ${m} is both best and avoid`);
  }
  if (!range(x.idealDays)) err(`${at}: idealDays must be [min, max]`);
  for (const t of TIERS) if (!range(x.dailyCostInr?.[t])) err(`${at}: dailyCostInr.${t} must be [min, max]`);
  for (const k of ["elders", "kids", "soloWomen"]) if (![1, 2, 3].includes(x.suitability?.[k])) err(`${at}: suitability.${k} must be 1, 2 or 3`);
  if (!x.highlights?.length) err(`${at}: needs at least one highlight`);
  for (const rid of x.ruleIds) if (!rids.has(rid)) err(`${at}: unknown rule "${rid}"`);
}

for (const x of l) {
  const at = `leg ${x.id}`;
  for (const k of ["from", "to"]) if (!dids.has(x[k]) && !gids.has(x[k])) err(`${at}: unknown ${k} "${x[k]}"`);
  if (!x.options?.length) err(`${at}: needs at least one option`);
  for (const o of x.options ?? []) {
    if (!MODES.includes(o.mode)) err(`${at}: unknown mode "${o.mode}"`);
    if (!range(o.durationHrs)) err(`${at}: durationHrs must be [min, max]`);
    if (!range(o.costInr)) err(`${at}: costInr must be [min, max]`);
    if (o.seasonal && !o.seasonal.openMonths.every(isMonth)) err(`${at}: seasonal.openMonths must be 1–12`);
  }
}

const linked = new Set(d.flatMap((x) => x.ruleIds));
for (const x of r) {
  const at = `rule ${x.id}`;
  if (!["info", "warn", "block"].includes(x.severity)) err(`${at}: severity must be info, warn or block`);
  if (!TRIGGERS.includes(x.trigger ?? "visit")) err(`${at}: unknown trigger "${x.trigger}"`);
  if (x.trigger === "stop" && !x.keywords?.length) err(`${at}: a "stop" rule needs keywords`);
  if (x.months && !x.months.every(isMonth)) err(`${at}: months must be 1–12`);
  if (!x.message) err(`${at}: needs a message`);
  for (const a of x.appliesTo) {
    if (!dids.has(a)) err(`${at}: unknown destination "${a}"`);
    else if (!d.find((y) => y.id === a).ruleIds.includes(x.id)) err(`${at}: applies to ${a}, but ${a}'s ruleIds doesn't list it`);
  }
  if (!linked.has(x.id)) err(`${at}: not linked from any destination`);
}

for (const x of g) for (const s of x.servesIds) if (!dids.has(s)) err(`gateway ${x.id}: unknown destination "${s}"`);

const reached = new Set(l.flatMap((x) => [x.from, x.to]));
for (const id of dids) if (!reached.has(id)) err(`destination ${id}: no leg reaches it`);

const verify = r.filter((x) => x.verify).length;
if (errors.length) {
  console.error(`✗ ${errors.length} problem(s) in the travel data:\n  - ` + errors.join("\n  - "));
  process.exit(1);
}
console.log(`✓ Travel data OK: ${d.length} destinations, ${l.length} legs, ${r.length} rules, ${g.length} gateways (${verify} rules marked "verify").`);
