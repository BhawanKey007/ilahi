// India Trip Planner — core data contracts.
// Every AI prompt, UI component and Claude connector tool reads/writes these shapes.
// Change them here first, then everywhere else follows.

export type Month = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
export type Region = "North" | "Himalaya" | "West" | "South" | "East" | "Northeast" | "Islands";
export type Vibe =
  | "mountains" | "heritage" | "spiritual" | "beach" | "food" | "wildlife"
  | "offbeat" | "adventure" | "backwaters" | "desert" | "nightlife";
export type BudgetTier = "backpacker" | "midrange" | "premium";
export type GroupType = "solo" | "couple" | "friends" | "family_kids" | "family_elders";
export type Mode = "train" | "flight" | "bus" | "cab" | "ferry" | "toy_train";
export type Severity = "info" | "warn" | "block";
export type Score = 1 | 2 | 3; // 1 = poor fit, 3 = great fit

// ---------- Knowledge base (curated, not AI-generated) ----------

export interface Destination {
  id: string;                       // "manali"
  name: string;
  state: string;
  region: Region;
  vibes: Vibe[];
  bestMonths: Month[];
  avoidMonths: { months: Month[]; reason: string }[];
  idealDays: [min: number, max: number];
  altitudeM?: number;               // triggers acclimatisation checks above ~3000 m
  nearestRailhead: { name: string; code?: string; distanceKm: number } | null;
  nearestAirport: { name: string; code: string; distanceKm: number };
  dailyCostInr: Record<BudgetTier, [min: number, max: number]>; // per person, stay+food+local transport
  highlights: string[];
  suitability: { elders: Score; kids: Score; soloWomen: Score };
  ruleIds: string[];                // links to rules.json
  notes?: string;
}

export interface LegOption {
  mode: Mode;
  durationHrs: [min: number, max: number];
  costInr: [min: number, max: number];   // per person, one way
  overnight?: boolean;
  seasonal?: { openMonths: Month[] };
  notes?: string;
}

export interface Leg {
  id: string;                       // "delhi__agra"
  from: string;                     // destination id or gateway id (gateways.json)
  to: string;                       // destination id or gateway id (legs are treated as bidirectional)
  options: LegOption[];
}

export interface Rule {
  id: string;
  type: "permit" | "closure_day" | "seasonal_closure" | "health" | "festival" | "weather";
  appliesTo: string[];              // destination ids
  months?: Month[];                 // when the rule is active
  weekdays?: (0 | 1 | 2 | 3 | 4 | 5 | 6)[]; // 0 = Sunday
  audience?: "all" | "indian" | "foreign";
  severity: Severity;
  message: string;                  // shown to the user as-is
  verify?: boolean;                 // true = check official source before launch
  // When the rule fires:
  //  "visit"        — any day based at the destination (default)
  //  "stop"         — only if a planned stop's name matches one of `keywords`
  //  "road_arrival" — only when arriving by cab or bus
  //  "altitude"     — handled by the acclimatisation check
  trigger?: "visit" | "stop" | "road_arrival" | "altitude";
  keywords?: string[];              // case-insensitive matches against stop names
}

export interface Gateway {
  id: string;                       // "njp" — transit hubs that aren't destinations themselves
  name: string;
  kind: "rail" | "air" | "rail+air";
  servesIds: string[];
  railCode?: string;
  airportCode?: string;
}

// ---------- Trip planning (what the user asks, what the app returns) ----------

export interface TripBrief {
  origin: string;                   // city name or destination id
  destinationIds?: string[];        // empty = "suggest where to go"
  startDate?: string;               // ISO date; or use month
  month?: Month;
  days: number;
  travellers: number;
  group: GroupType;
  budget: BudgetTier;
  vibes: Vibe[];
  nationality: "indian" | "foreign";
  notes?: string;                   // free text: "elderly parent, avoid stairs"
}

export interface Stop {
  time?: string;                    // "09:00" or "Morning"
  name: string;
  blurb: string;
  costInr?: number;
}

export interface PlannedLeg {
  from: string;
  to: string;
  mode: Mode;
  departTime?: string;
  durationHrs: number;
  costInr: number;
  bookingTip?: string;              // "Book 60 days ahead; Tatkal opens 10:00 day before"
}

export interface Day {
  day: number;
  date?: string;
  baseId: string;                   // where you sleep
  title: string;
  leg?: PlannedLeg;                 // travel done on this day, if any
  stops: Stop[];
}

export interface Warning {
  ruleId?: string;
  severity: Severity;
  message: string;
  day?: number;
}

export interface Itinerary {
  id: string;
  title: string;
  brief: TripBrief;
  summary: string;
  days: Day[];
  budget: {
    perPersonInr: number;
    breakdown: { stay: number; food: number; transport: number; activities: number };
  };
  warnings: Warning[];
  generatedBy: "template" | "ai";
}
