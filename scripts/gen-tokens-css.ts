// Generates packages/cli/ui/tokens.css from brand/tokens.json. Run: npm run docs:tokens. Never hand-copy hex values.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dirname, "..");
const t = JSON.parse(readFileSync(join(root, "brand", "tokens.json"), "utf8"));
const lines: string[] = ["/* Generated from brand/tokens.json by scripts/gen-tokens-css.ts. Do not edit. */", ""];
const colorVars = (theme: "light" | "dark") => t.color.tokens.map((c: { name: string; value: Record<string, string> }) => `  --${c.name}: ${c.value[theme]};`);
lines.push(":root {", ...colorVars("light"));
for (const s of t.spacing.tokens) lines.push(`  --${s.name}: ${s.value};`);
for (const r of t.radius.tokens) lines.push(`  --${r.name}: ${r.value};`);
for (const [k, v] of Object.entries(t.type.families)) lines.push(`  --font-${k}: ${v};`);
lines.push("}", "", "@media (prefers-color-scheme: dark) {", "  :root:not([data-theme=\"light\"]) {", ...colorVars("dark").map((l) => "  " + l), "  }", "}", "", ":root[data-theme=\"dark\"] {", ...colorVars("dark"), "}", "");
for (const g of t.type.groups) for (const s of g.styles) {
  const fam = s.family ?? g.family;
  lines.push(`.t-${s.name} { font-family: var(--font-${fam}); font-size: ${s.fontSize}; line-height: ${s.lineHeight}; font-weight: ${s.fontWeight};${s.letterSpacing ? ` letter-spacing: ${s.letterSpacing};` : ""} }`);
}
writeFileSync(join(root, "packages", "cli", "ui", "tokens.css"), lines.join("\n") + "\n");
console.log("wrote packages/cli/ui/tokens.css");
