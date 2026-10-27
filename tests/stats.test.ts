import { describe, expect, it } from "vitest";
import { bootstrapRates, correctForJudgeError, matrixOf, pairedDelta, passRateWithJudgeError, tnr, tpr, wilson } from "../packages/cli/src/stats.ts";

describe("rates", () => {
  const pairs = [
    ...Array(18).fill({ human: "Fail", judge: "Fail" }), ...Array(2).fill({ human: "Fail", judge: "Pass" }),
    ...Array(19).fill({ human: "Pass", judge: "Pass" }), ...Array(1).fill({ human: "Pass", judge: "Fail" }), { human: "Pass", judge: "Unknown" },
  ] as { human: "Pass" | "Fail"; judge: "Pass" | "Fail" | "Unknown" }[];
  it("builds the matrix with Fail as positive and counts Unknown apart", () => {
    const m = matrixOf(pairs);
    expect(m).toEqual({ tp: 18, fn: 2, tn: 19, fp: 1, unknown: 1 });
    expect(tpr(m)).toBe(90); expect(tnr(m)).toBe(95);
  });
  it("bootstraps intervals that contain the point estimate and are reproducible", () => {
    const a = bootstrapRates(pairs, 500, 7), b = bootstrapRates(pairs, 500, 7);
    expect(a).toEqual(b);
    expect(a.tpr.low).toBeLessThanOrEqual(90); expect(a.tpr.high).toBeGreaterThanOrEqual(90);
    expect(a.tnr.low).toBeLessThan(a.tnr.high);
  });
  it("wilson interval behaves at the edges", () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 100, method: "wilson" });
    const w = wilson(45, 50); expect(w.low).toBeLessThan(90); expect(w.high).toBeGreaterThan(90);
  });
});

describe("judge-error correction", () => {
  it("recovers the true fail rate from a noisy judge", () => {
    // true fail rate 20%; judge TPR 90, TNR 95: observed = 0.2*0.9 + 0.8*0.05 = 22%
    expect(correctForJudgeError(22, 90, 95)).toBe(20);
    expect(correctForJudgeError(22, 50, 50)).toBe(22); // chance judge: leave it alone
    expect(correctForJudgeError(2, 90, 95)).toBe(0); // clamp
  });
  it("pass rate with judge error widens the interval compared with sampling alone", () => {
    const outcomes = Array.from({ length: 100 }, (_, i) => i % 5 !== 0); // 80% pass
    const plain = passRateWithJudgeError(outcomes);
    const judged = passRateWithJudgeError(outcomes, { matrix: { tp: 18, fn: 2, tn: 19, fp: 1, unknown: 0 } });
    expect(plain.rate).toBe(80);
    expect(judged.ci.high - judged.ci.low).toBeGreaterThan(plain.ci.high - plain.ci.low);
  });
  it("paired delta flags a real change and not noise", () => {
    const a = Array.from({ length: 40 }, () => [true, true, false, true, true]);
    const b = Array.from({ length: 40 }, () => [true, true, true, true, true]);
    const d = pairedDelta(a, b); expect(d.delta).toBe(20); expect(d.significant).toBe(true);
    const same = pairedDelta(a, a); expect(same.delta).toBe(0); expect(same.significant).toBe(false);
  });
});
