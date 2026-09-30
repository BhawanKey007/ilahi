// ilAhi rules engine: deterministic, no AI, no network.
// Shared by the web app (site/app.js), the tests and the Cloudflare Worker.
// Shapes are documented in ../types.ts.
//
//   suggest(brief)       ranks destinations for a trip brief ("Where to go")
//   check(itinerary)     validates any itinerary against the knowledge base
//   estimateBudget(itin) per-person cost from curated ranges
//   legOptions(a, b, m)  travel options between two places, split by season

export const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const HIGH_EXERTION = ["khardung", "pangong", "nubra", "chandratal", "tso moriri", " la ", "pass", "trek"];
const LONG_DAY_HRS = 10;
const SEVERITY_ORDER = { block: 0, warn: 1, info: 2 };

export class Engine {
  /** @param {{destinations: any[], legs: any[], rules: any[], gateways: any[]}} kb */
  constructor(kb) {
    this.kb = kb;
    this.dest = new Map(kb.destinations.map((d) => [d.id, d]));
    this.legByPair = new Map();
    for (const l of kb.legs) {
      this.legByPair.set(`${l.from}>${l.to}`, l);
      this.legByPair.set(`${l.to}>${l.from}`, l); // legs are bidirectional
    }
  }

  // ---------- travel ----------

  findLeg(from, to) {
    return this.legByPair.get(`${from}>${to}`);
  }

  legOptions(from, to, month) {
    const open = [], closed = [];
    for (const o of this.findLeg(from, to)?.options ?? []) {
      (month && o.seasonal && !o.seasonal.openMonths.includes(month) ? closed : open).push(o);
    }
    return { open, closed };
  }

  // ---------- suggestions ----------

  suggest(brief, limit = 3) {
    const month = brief.month ?? monthOf(brief.startDate);
    const out = [];

    for (const d of this.kb.destinations) {
      if (month && d.avoidMonths.some((a) => a.months.includes(month))) continue;
      if (d.idealDays[0] > brief.days) continue;

      const matched = d.vibes.filter((v) => brief.vibes.includes(v));
      if (brief.vibes.length && matched.length === 0) continue;

      let score = matched.length * 3;
      const reasons = [], tags = [];
      if (matched.length) reasons.push(`Great for ${matched.join(" and ")}`);

      if (month && d.bestMonths.includes(month)) {
        score += 3;
        tags.push("Peak season");
        reasons.push(`Best season in ${MONTHS[month]}`);
      }

      if (brief.group === "family_elders") score += (d.suitability.elders - 2) * 2;
      if (brief.group === "family_kids") score += (d.suitability.kids - 2) * 2;

      const active = this.rulesFor(d.id, brief).filter((r) => isMonthActive(r, month));
      const festival = active.find((r) => r.type === "festival");
      if (festival) {
        score += 1;
        tags.push("Festival this month");
      }
      if (active.some((r) => r.type === "permit" && r.severity === "block")) tags.push("Permit needed");
      const notices = active.filter((r) => r.type === "festival" || r.severity === "info");

      out.push({ destination: d, score, reasons, tags, notices, festival });
    }

    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ---------- itinerary checks ----------

  check(itin) {
    const brief = itin.brief;
    const days = withDates(itin.days, brief.startDate);
    const warnings = [];
    const seen = new Set();
    const add = (w, key) => {
      const k = key ?? (w.ruleId || w.message);
      if (seen.has(k)) return;
      seen.add(k);
      warnings.push(w);
    };

    days.forEach((day, i) => {
      const d = this.dest.get(day.baseId);
      if (!d) {
        add({ severity: "warn", day: day.day, message: `Day ${day.day}: "${day.baseId}" isn't in ilAhi's destination data, so it couldn't be checked.` });
        return;
      }
      const month = monthOf(day.date) ?? brief.month;
      const weekday = weekdayOf(day.date);

      // Season
      const avoid = month ? d.avoidMonths.find((a) => a.months.includes(month)) : undefined;
      if (avoid) add({ severity: "warn", day: day.day, message: `${d.name} in ${MONTHS[month]}: ${avoid.reason}.` }, `avoid:${d.id}`);

      // Knowledge-base rules. On a travel day, stops can be in the city being left,
      // so stop-triggered rules for leg.from are checked too.
      const targets = [[d.id, false]];
      if (day.leg && day.leg.from !== d.id && this.dest.has(day.leg.from)) targets.push([day.leg.from, true]);
      for (const [target, stopOnly] of targets) {
        for (const r of this.rulesFor(target, brief)) {
          if (stopOnly && r.trigger !== "stop") continue;
          if (r.trigger === "altitude") continue;
          if (!isMonthActive(r, month)) continue;
          if (r.weekdays && (weekday === undefined || !r.weekdays.includes(weekday))) continue;
          if (r.trigger === "stop" && !day.stops.some((s) => matches(s.name, r.keywords))) continue;
          if (r.trigger === "road_arrival" && !(day.leg && day.leg.to === d.id && ["cab", "bus"].includes(day.leg.mode))) continue;
          add({ ruleId: r.id, severity: r.severity, day: day.day, message: r.message });
        }
      }

      // Missing travel between bases
      const prev = days[i - 1];
      if (prev && prev.baseId !== day.baseId && !day.leg) {
        add({ severity: "warn", day: day.day, message: `Day ${day.day}: the plan moves from ${this.name(prev.baseId)} to ${d.name} but has no travel leg.` });
      }

      if (day.leg) this.#checkLeg(day, month, add);

      if (day.stops.length > 5) add({ severity: "info", day: day.day, message: `Day ${day.day} has ${day.stops.length} stops. Consider dropping one or two.` });
    });

    this.#checkAltitude(days, add);
    this.#checkStayLength(days, add);
    this.#checkGroupFit(days, brief, add);

    return warnings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.day ?? 0) - (b.day ?? 0));
  }

  #checkLeg(day, month, add) {
    const p = day.leg;
    const route = `${this.name(p.from)} → ${this.name(p.to)}`;
    const leg = this.findLeg(p.from, p.to);
    if (!leg) {
      add({ severity: "info", day: day.day, message: `Day ${day.day}: no verified travel data for ${route}. Double-check the timing.` });
      return;
    }
    const opt = leg.options.find((o) => o.mode === p.mode);
    if (!opt) {
      const modes = leg.options.map((o) => modeName(o.mode)).join(", ");
      add({ severity: "info", day: day.day, message: `Day ${day.day}: ${modeName(p.mode)} isn't a usual way to do ${route}. Usual options: ${modes}.` });
      return;
    }
    if (month && opt.seasonal && !opt.seasonal.openMonths.includes(month)) {
      const alt = leg.options
        .filter((o) => o !== opt && (!o.seasonal || o.seasonal.openMonths.includes(month)))
        .map((o) => modeName(o.mode));
      add({ severity: "block", day: day.day, message: `Day ${day.day}: ${route} by ${modeName(p.mode)} is usually closed in ${MONTHS[month]}.${alt.length ? ` Try ${alt.join(" or ")}.` : ""}` });
    }
    if (p.durationHrs < opt.durationHrs[0] * 0.8) {
      add({ severity: "warn", day: day.day, message: `Day ${day.day}: ${route} by ${modeName(p.mode)} realistically takes ${fmtRange(opt.durationHrs)} h, not ${p.durationHrs} h.` });
    }
    const hrs = Math.max(p.durationHrs, opt.durationHrs[0]);
    if (hrs >= LONG_DAY_HRS && !opt.overnight) {
      add({ severity: "warn", day: day.day, message: `Day ${day.day}: ${route} is a ${fmtRange(opt.durationHrs)} h journey. Split it with a night halfway or pick an overnight option.` });
    } else if (hrs >= 5 && day.stops.length >= 3) {
      add({ severity: "warn", day: day.day, message: `Day ${day.day} pairs a ${fmtRange(opt.durationHrs)} h journey with ${day.stops.length} stops. That's a packed day.` });
    }
  }

  #checkAltitude(days, add) {
    const arrived = new Set();
    days.forEach((day, i) => {
      const d = this.dest.get(day.baseId);
      if (!d || !d.altitudeM || d.altitudeM < 3000 || arrived.has(d.id)) return;
      arrived.add(d.id);
      const rule = this.kb.rules.find((r) => r.trigger === "altitude" && r.appliesTo.includes(d.id));
      const firstTwo = [day, days[i + 1]].filter(Boolean);
      const strain = firstTwo.find((x) =>
        x.stops.some((s) => matches(s.name, HIGH_EXERTION)) || (x !== day && x.leg && x.leg.from === d.id));
      if (strain) {
        add({ ruleId: rule?.id, severity: "block", day: strain.day, message: `Day ${strain.day}: too much too soon at ${d.altitudeM} m. ${rule?.message ?? "Rest for 24–48 hours after arrival."}` }, `alt:${d.id}`);
      } else if (rule) {
        add({ ruleId: rule.id, severity: "info", day: day.day, message: rule.message }, `alt:${d.id}`);
      }
    });
  }

  #checkStayLength(days, add) {
    const count = new Map();
    for (const d of days) count.set(d.baseId, (count.get(d.baseId) ?? 0) + 1);
    for (const [id, n] of count) {
      const d = this.dest.get(id);
      if (d && n < d.idealDays[0]) {
        add({ severity: "info", message: `Only ${n} day${n > 1 ? "s" : ""} in ${d.name}. Most people need at least ${d.idealDays[0]}.` }, `stay:${id}`);
      }
    }
  }

  #checkGroupFit(days, brief, add) {
    for (const id of new Set(days.map((d) => d.baseId))) {
      const d = this.dest.get(id);
      if (!d) continue;
      if (brief.group === "family_elders" && d.suitability.elders === 1)
        add({ severity: "warn", message: `${d.name} is demanding for elderly travellers (altitude, long road days). Consider an easier alternative.` }, `fit:${id}`);
      if (brief.group === "family_kids" && d.suitability.kids === 1)
        add({ severity: "warn", message: `${d.name} is tough with young kids. Check altitude and road conditions first.` }, `fit:${id}`);
    }
  }

  // ---------- budget ----------

  estimateBudget(itin) {
    const tier = itin.brief.budget;
    let stay = 0, food = 0, activities = 0, transport = 0;
    for (const day of itin.days) {
      const d = this.dest.get(day.baseId);
      if (d) {
        const [lo, hi] = d.dailyCostInr[tier];
        const mid = (lo + hi) / 2;
        stay += mid * 0.5;
        food += mid * 0.25;
        activities += mid * 0.25;
      }
      transport += Number(day.leg?.costInr) || 0;
    }
    const r = (n) => Math.round(n / 500) * 500;
    const breakdown = { stay: r(stay), food: r(food), transport: r(transport), activities: r(activities) };
    return { perPersonInr: breakdown.stay + breakdown.food + breakdown.transport + breakdown.activities, breakdown };
  }

  // ---------- helpers ----------

  rulesFor(destId, brief) {
    return this.kb.rules.filter((r) =>
      r.appliesTo.includes(destId) && (!r.audience || r.audience === "all" || r.audience === brief.nationality));
  }

  name(id) {
    return this.dest.get(id)?.name ?? this.kb.gateways.find((g) => g.id === id)?.name ?? id;
  }
}

// ---------- pure helpers ----------

export function withDates(days, startDate) {
  if (!startDate) return days;
  const start = new Date(startDate + "T00:00:00Z");
  return days.map((d) => {
    if (d.date) return d;
    const dt = new Date(start);
    dt.setUTCDate(start.getUTCDate() + d.day - 1);
    return { ...d, date: dt.toISOString().slice(0, 10) };
  });
}

export function monthOf(date) {
  return date ? Number(date.slice(5, 7)) : undefined;
}

export function weekdayOf(date) {
  return date ? new Date(date + "T00:00:00Z").getUTCDay() : undefined;
}

export function isMonthActive(r, month) {
  return !r.months || (month !== undefined && r.months.includes(month));
}

export function modeName(m) {
  return m === "toy_train" ? "toy train" : m;
}

function matches(text, keywords) {
  const t = ` ${String(text).toLowerCase()} `;
  return (keywords ?? []).some((k) => t.includes(k.toLowerCase()));
}

function fmtRange([a, b]) {
  return a === b ? `${a}` : `${a}–${b}`;
}
