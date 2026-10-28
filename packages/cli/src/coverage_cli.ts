// `litmustest coverage`: the three coverage maps in a terminal, for people and CI.
import type { Coverage, CoverageItem, CoverageMap } from "./coverage.ts";

const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0);
const PRI: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
const SEV: Record<string, number> = { high: 0, med: 1, low: 2 };

/** Uncovered items, most important first: spec by priority, risk by severity, then by area. */
export function gaps(c: Coverage, limit = 10): (CoverageItem & { map: string })[] {
  const out: (CoverageItem & { map: string })[] = [];
  for (const m of Object.values(c.maps)) for (const i of m.items) if (i.depth === "none" || (m.key === "risk" && i.depth === "planned")) out.push({ ...i, map: m.key });
  const rank = (i: CoverageItem & { map: string }) => (i.map === "risk" ? SEV[i.area] ?? 3 : i.priority ? PRI[i.priority] ?? 5 : 5);
  return out.sort((a, b) => rank(a) - rank(b) || a.map.localeCompare(b.map) || a.id.localeCompare(b.id)).slice(0, limit);
}

export function coverageText(c: Coverage, opts: { gaps?: number } = {}): string {
  const lines = [`Coverage${c.run_id ? ` against ${c.run_id}` : " (no runs yet: nothing can be checked or guarded)"}`, `v1 measures three maps: spec, surface and risk. It does not measure production traffic, code lines or the frontend.`, ""];
  const row = (m: CoverageMap) => {
    if (!m.configured) return [`${m.label.padEnd(8)} not measured. ${m.reason}`];
    const t = m.totals; const cov = t.total - t.none;
    const weakest = m.areas.filter((a) => a.total).sort((a, b) => a.checked / a.total - b.checked / b.total || b.total - a.total).slice(0, 4).map((a) => `${a.name} ${a.checked}/${a.total}`);
    return [`${m.label.padEnd(8)} ${pct(t.checked + t.guarded, t.total)}% checked or guarded · ${cov} of ${t.total} have a task · guarded ${t.guarded} · checked ${t.checked} · planned ${t.planned} · none ${t.none}`, ...(m.areas.length > 1 ? [`         weakest: ${weakest.join(" · ")}`] : [])];
  };
  for (const m of Object.values(c.maps)) lines.push(...row(m));
  const g = gaps(c, opts.gaps ?? 10);
  if (g.length) { lines.push("", "Gaps, most important first:"); for (const i of g) lines.push(`  ${i.map.padEnd(8)} ${(i.priority ?? (i.map === "risk" ? i.area : "")).padEnd(5)} ${i.id}${i.title ? `  ${i.title.slice(0, 90)}` : ""}${i.map === "risk" && i.depth === "planned" ? "  (no check that counts yet)" : ""}`); }
  for (const w of c.warnings) lines.push(`  warning ${w}`);
  lines.push("", "Depth: guarded = a passing regression task; checked = a passing task; planned = only capability or unpassed tasks; none = no task.");
  return lines.join("\n");
}

/** --fail-under spec=20 surface=30: the share at checked or better. */
export function underThresholds(c: Coverage, specs: string[]): string[] {
  const out: string[] = [];
  for (const s of specs) {
    const [k, v] = s.split("="); const m = c.maps[k as keyof Coverage["maps"]];
    if (!m || !v || Number.isNaN(Number(v))) { out.push(`bad threshold ${s}; use spec=20, surface=30 or risk=100`); continue; }
    const got = pct(m.totals.checked + m.totals.guarded, m.totals.total);
    if (m.configured && got < Number(v)) out.push(`${k} coverage ${got}% is under ${v}%`);
  }
  return out;
}
