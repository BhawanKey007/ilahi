// Builds the single-page version of ilAhi that runs inside Claude (a Claude artifact),
// where plans are written by the viewer's own Claude account.
// Output: dist/claude/index.html plus dist/claude/data/*.json
// Run: npm run build:claude
import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

// Inline the three modules in dependency order, dropping import/export syntax.
const strip = (src) => src
  .replace(/^import [\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
  .replace(/^export (?=(const|function|class|let|async) )/gm, "");
const js = ["site/engine.js", "site/planner.js", "site/app.js"].map((p) => `// ---- ${p} ----\n${strip(read(p))}`).join("\n");

const html = read("site/index.html");
const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"))
  .replace(/<script src="config\.js"><\/script>/, "")
  .replace(/<script type="module" src="app\.js"><\/script>/, "")
  .replace(/<noscript>[\s\S]*?<\/noscript>/, "");
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/)[0];

const out = `<title>ilAhi</title>
${fonts}
<style>
${read("site/styles.css")}
</style>
${body.trim()}
<script>window.ILAHI_CONFIG = { plannerUrl: "" };</script>
<script type="module">
${js}
</script>
`;

mkdirSync(new URL("dist/claude/", root), { recursive: true });
writeFileSync(new URL("dist/claude/index.html", root), out);
cpSync(new URL("site/data/", root), new URL("dist/claude/data/", root), { recursive: true });
console.log(`✓ Built dist/claude/index.html (${(out.length / 1024).toFixed(0)} KB) and dist/claude/data/`);
