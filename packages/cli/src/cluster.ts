// Offline clustering for trace sampling: TF-IDF over the derived text, spherical k-means with a fixed seed.
// No model calls, so ingest works without a key and gives the same batch every time.
export interface ClusterResult { assignments: number[]; centroids: Map<string, number>[]; terms: string[][]; representatives: number[] }

const STOP = new Set("a an and are as at be but by for from has have i if in is it its my me of on or that the their this to was we were what when where which who will with you your can could would should please hi hello thanks thank just so not no yes do does did our us am been being".split(" "));

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9_@.$ ]+/g, " ").split(/\s+/).map((w) => w.replace(/^[.$]+|[.$]+$/g, "")).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w) && !w.includes("@") && !/^(inv|acc|tr|tc|s)_/.test(w));
}

export function tfidf(docs: string[]): Map<string, number>[] {
  const tf = docs.map((d) => { const m = new Map<string, number>(); for (const w of tokenize(d)) m.set(w, (m.get(w) ?? 0) + 1); return m; });
  const df = new Map<string, number>();
  for (const m of tf) for (const w of m.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const n = docs.length;
  return tf.map((m) => {
    const v = new Map<string, number>();
    for (const [w, c] of m) { const idf = Math.log((1 + n) / (1 + (df.get(w) ?? 0))) + 1; if ((df.get(w) ?? 0) < n) v.set(w, (1 + Math.log(c)) * idf); }
    return normalize(v);
  });
}

function normalize(v: Map<string, number>): Map<string, number> {
  let s = 0; for (const x of v.values()) s += x * x; const len = Math.sqrt(s) || 1;
  const out = new Map<string, number>(); for (const [k, x] of v) out.set(k, x / len); return out;
}
function dot(a: Map<string, number>, b: Map<string, number>): number {
  let s = 0; const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, x] of small) { const y = big.get(k); if (y) s += x * y; } return s;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function kmeans(vectors: Map<string, number>[], k: number, seed = 1, iters = 25): ClusterResult {
  const n = vectors.length; k = Math.max(1, Math.min(k, n));
  const rng = mulberry32(seed);
  // k-means++ seeding
  const centroids: Map<string, number>[] = [vectors[Math.floor(rng() * n)]!];
  while (centroids.length < k) {
    const d = vectors.map((v) => Math.max(0, 1 - Math.max(...centroids.map((c) => dot(v, c)))));
    const total = d.reduce((a, b) => a + b, 0);
    let r = rng() * total, ix = 0;
    if (total === 0) ix = Math.floor(rng() * n); else for (ix = 0; ix < n; ix++) { r -= d[ix]!; if (r <= 0) break; }
    centroids.push(vectors[Math.min(ix, n - 1)]!);
  }
  let assignments = new Array<number>(n).fill(0);
  for (let it = 0; it < iters; it++) {
    const next = vectors.map((v) => { let best = 0, bs = -Infinity; centroids.forEach((c, j) => { const s = dot(v, c); if (s > bs) { bs = s; best = j; } }); return best; });
    const changed = next.some((x, i) => x !== assignments[i]); assignments = next;
    for (let j = 0; j < k; j++) {
      const members = vectors.filter((_, i) => assignments[i] === j);
      if (!members.length) continue;
      const sum = new Map<string, number>();
      for (const m of members) for (const [w, x] of m) sum.set(w, (sum.get(w) ?? 0) + x);
      centroids[j] = normalize(sum);
    }
    if (!changed && it > 0) break;
  }
  const representatives = centroids.map((c, j) => { let best = -1, bs = -Infinity; vectors.forEach((v, i) => { if (assignments[i] === j) { const s = dot(v, c); if (s > bs) { bs = s; best = i; } } }); return best; });
  const terms = centroids.map((c) => [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w));
  return { assignments, centroids, terms, representatives };
}
