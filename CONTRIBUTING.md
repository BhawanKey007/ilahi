# Contributing to ilAhi

The most useful contribution is better travel data: a corrected closing day, a new route, a permit rule. You don't need to write code for that.

## Fixing or adding travel data

All data lives in `site/data/`. Shapes are documented in [`types.ts`](types.ts).

| File | What's in it |
|---|---|
| `destinations.json` | Places: best and avoid months (with reasons), ideal days, altitude, nearest station and airport, daily cost by budget tier, highlights, suitability for elders, kids and solo women |
| `legs.json` | Routes between places: mode, duration range, cost range per person, overnight and seasonal options |
| `rules.json` | Permits, closure days, seasonal closures, health, weather and festival notes |
| `gateways.json` | Transit hubs that aren't destinations themselves (NJP, Guwahati, Kochi, Chennai) |

### Rules: when does a rule fire?

Each rule has a `trigger`:

- `visit` (default): any day based at the destination, in the rule's `months` and `weekdays` if set.
- `stop`: only when a planned stop's name contains one of `keywords`. Use this for closures of one sight, so the Taj rule doesn't flag every Friday in Agra.
- `road_arrival`: only when arriving by cab or bus.
- `altitude`: used by the acclimatisation check for places above 3,000 m.

`severity` is `block` (the plan is wrong and the AI is asked to fix it), `warn` or `info`. Set `"verify": true` on anything that changes year to year.

### Checklist for a data change

1. Include a source in your pull request, ideally an official one.
2. When you add a rule, also add its `id` to each destination's `ruleIds`.
3. When you add a destination, add at least one leg that reaches it.
4. Run `npm run check`. The validator catches broken links, best months that are also avoid months, and missing fields.

## Code changes

- `site/engine.js` is the single source of the rules. The web app, the tests and the Worker all import it.
- `site/planner.js` builds prompts and cleans AI output. It's shared with the Worker, so never make the Worker accept a raw prompt.
- Add or update a test in `tests/` for any behaviour change, and keep `npm run check` passing.
- No build step and no framework: keep the site plain HTML, CSS and JavaScript modules.

## Reporting a problem

Use the **Wrong travel information** issue template for data, or a blank issue for bugs.
