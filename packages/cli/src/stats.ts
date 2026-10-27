// Statistics shared by calibrate (judge agreement) and, later, run and compare (pass rates with error bars).
// Every number that reaches a person carries an interval; these are the functions that make them.

export interface Matrix { tp: number; tn: number; fp: number; fn: number; unknown: number }
export interface Interval { low: number; high: number; method: "bootstrap" | "wilson" | "normal" }

/** Deterministic PRNG so bootstraps are reproducible for a given seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Confusion matrix with Fail as the positive class: a judge that says Fail when the human said Fail is a true positive. */
export function matrixOf(pairs: { human: "Pass" | "Fail"; judge: "Pass" | "Fail" | "Unknown" }[]): Matrix {
  const m: Matrix = { tp: 0, tn: 0, fp: 0, fn: 0, unknown: 0 };
  for (const p of pairs) {
    if (p.judge === "Unknown") m.unknown++;
    else if (p.human === "Fail") p.judge === "Fail" ? m.tp++ : m.fn++;
    else p.judge === "Fail" ? m.fp++ : m.tn++;
  }
  return m;
}
export const tpr = (m: Matrix): number => (m.tp + m.fn ? (100 * m.tp) / (m.tp + m.fn) : 0);
export const tnr = (m: Matrix): number => (m.tn + m.fp ? (100 * m.tn) / (m.tn + m.fp) : 0);

/** Percentile bootstrap over the labelled traces for TPR and TNR. */
export function bootstrapRates(pairs: { human: "Pass" | "Fail"; judge: "Pass" | "Fail" | "Unknown" }[], resamples = 1000, seed = 1): { tpr: Interval; tnr: Interval } {
  const rng = mulberry32(seed); const n = pairs.length;
  const tprs: number[] = []; const tnrs: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sample = Array.from({ length: n }, () => pairs[Math.floor(rng() * n)]!);
    const m = matrixOf(sample); tprs.push(tpr(m)); tnrs.push(tnr(m));
  }
  return { tpr: percentileInterval(tprs), tnr: percentileInterval(tnrs) };
}
export function percentileInterval(xs: number[], alpha = 0.05): Interval {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))] ?? 0;
  return { low: +at(alpha / 2).toFixed(1), high: +at(1 - alpha / 2).toFixed(1), method: "bootstrap" };
}
/** Wilson score interval for a proportion, as a fallback when there is nothing to bootstrap over. */
export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (!n) return { low: 0, high: 100, method: "wilson" };
  const p = successes / n; const d = 1 + (z * z) / n; const c = (p + (z * z) / (2 * n)) / d; const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: +(100 * Math.max(0, c - h)).toFixed(1), high: +(100 * Math.min(1, c + h)).toFixed(1), method: "wilson" };
}

/**
 * Correct an observed Fail rate for judge error (Rogan-Gladen): the judge's Fail rate mixes true fails caught (TPR)
 * with passes wrongly failed (1 - TNR). Returns the estimated true Fail rate in percent, clamped to [0, 100].
 */
export function correctForJudgeError(observedFailRate: number, judgeTpr: number, judgeTnr: number): number {
  const p = observedFailRate / 100, s = judgeTpr / 100, t = judgeTnr / 100;
  const denom = s + t - 1;
  if (denom <= 0.05) return observedFailRate; // a judge no better than chance cannot be corrected
  return +Math.min(100, Math.max(0, (100 * (p + t - 1)) / denom)).toFixed(1);
}

/**
 * One bootstrap over tasks and judge confusion together: resample the task outcomes and, for judge-scored checks,
 * resample the judge's confusion matrix, then correct. Gives a pass rate with an interval that carries both error terms.
 */
export function passRateWithJudgeError(outcomes: boolean[], judge?: { matrix: Matrix }, resamples = 1000, seed = 1): { rate: number; ci: Interval } {
  const n = outcomes.length;
  if (!n) return { rate: 0, ci: { low: 0, high: 0, method: "bootstrap" } };
  const rng = mulberry32(seed);
  const pairs = judge ? expandMatrix(judge.matrix) : [];
  const rates: number[] = [];
  const point = () => { const fail = 100 * outcomes.filter((o) => !o).length / n; if (!judge) return 100 - fail; const m = judge.matrix; return 100 - correctForJudgeError(fail, tpr(m), tnr(m)); };
  for (let r = 0; r < resamples; r++) {
    const sample = Array.from({ length: n }, () => outcomes[Math.floor(rng() * n)]!);
    const fail = 100 * sample.filter((o) => !o).length / n;
    if (!judge) { rates.push(100 - fail); continue; }
    const jm = matrixOf(Array.from({ length: pairs.length }, () => pairs[Math.floor(rng() * pairs.length)]!));
    rates.push(100 - correctForJudgeError(fail, tpr(jm), tnr(jm)));
  }
  return { rate: +point().toFixed(1), ci: percentileInterval(rates) };
}
function expandMatrix(m: Matrix): { human: "Pass" | "Fail"; judge: "Pass" | "Fail" | "Unknown" }[] {
  const out: { human: "Pass" | "Fail"; judge: "Pass" | "Fail" | "Unknown" }[] = [];
  for (let i = 0; i < m.tp; i++) out.push({ human: "Fail", judge: "Fail" });
  for (let i = 0; i < m.fn; i++) out.push({ human: "Fail", judge: "Pass" });
  for (let i = 0; i < m.fp; i++) out.push({ human: "Pass", judge: "Fail" });
  for (let i = 0; i < m.tn; i++) out.push({ human: "Pass", judge: "Pass" });
  return out;
}

/** Paired delta between two runs over the same tasks, with a bootstrap interval over tasks. */
export function pairedDelta(a: boolean[][], b: boolean[][], resamples = 1000, seed = 1): { delta: number; ci: Interval; significant: boolean } {
  const n = Math.min(a.length, b.length);
  const rate = (t: boolean[]) => (t.length ? (100 * t.filter(Boolean).length) / t.length : 0);
  const diffs = Array.from({ length: n }, (_, i) => rate(b[i]!) - rate(a[i]!));
  const point = diffs.reduce((x, y) => x + y, 0) / (n || 1);
  const rng = mulberry32(seed); const ds: number[] = [];
  for (let r = 0; r < resamples; r++) { let s = 0; for (let i = 0; i < n; i++) s += diffs[Math.floor(rng() * n)]!; ds.push(s / (n || 1)); }
  const ci = percentileInterval(ds);
  return { delta: +point.toFixed(1), ci, significant: ci.low > 0 || ci.high < 0 };
}
