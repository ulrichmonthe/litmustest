// Contrast (docs/BRAND.md): every text token meets 4.5:1 on each ground it is used on, in both themes;
// marks that are not text (the verdict-strip dots) meet 3:1. Computed from brand/tokens.json with the WCAG 2.1 formula.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tokens = JSON.parse(readFileSync(join(import.meta.dirname, "..", "brand", "tokens.json"), "utf8")) as { color: { tokens: { name: string; value: Record<string, string> }[] } };
const colour = (name: string, theme: string) => { const t = tokens.color.tokens.find((c) => c.name === name); if (!t) throw new Error(`no token ${name}`); return t.value[theme]!; };
const luminance = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
export const ratio = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

const GROUNDS = ["ground", "surface", "surface-sunken"];
// [text token, the grounds app.css puts it on]
const TEXT: [string, string[]][] = [
  ["ink", [...GROUNDS, "neutral-tint", "good-tint", "warn-tint", "bad-tint"]],
  ["ink-muted", [...GROUNDS, "neutral-tint", "blue-tint"]],
  ["ink-faint", GROUNDS],
  ["blue-ink", [...GROUNDS, "blue-tint"]],
  ["blue", GROUNDS],
  ["good", [...GROUNDS, "good-tint"]],
  ["warn", [...GROUNDS, "warn-tint"]],
  ["bad", [...GROUNDS, "bad-tint"]],
  ["slate-ink", ["slate"]],
  ["ground", ["blue"]], // the primary button's label
];
const MARKS: [string, string[]][] = [["slate-good", ["slate"]], ["slate-bad", ["slate"]], ["slate-neutral", ["slate"]]];

describe("contrast in both themes", () => {
  for (const theme of ["light", "dark"]) {
    it(`${theme}: text tokens reach 4.5:1 on their grounds`, () => {
      const low = TEXT.flatMap(([t, gs]) => gs.map((g) => ({ pair: `${t} on ${g}`, r: +ratio(colour(t, theme), colour(g, theme)).toFixed(2) }))).filter((x) => x.r < 4.5);
      expect(low).toEqual([]);
    });
    it(`${theme}: marks reach 3:1 on their grounds`, () => {
      const low = MARKS.flatMap(([t, gs]) => gs.map((g) => ({ pair: `${t} on ${g}`, r: +ratio(colour(t, theme), colour(g, theme)).toFixed(2) }))).filter((x) => x.r < 3);
      expect(low).toEqual([]);
    });
  }
});
