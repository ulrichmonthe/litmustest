import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateEvals } from "../packages/cli/src/validate.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const good = join(fixtures, "good", "evals");
const bad = join(fixtures, "bad", "evals");

describe("good fixture", () => {
  const r = validateEvals(good, { deep: true });
  it("has no errors", () => {
    expect(r.problems.filter((p) => p.level === "error")).toEqual([]);
    expect(r.errors).toBe(0);
  });
  it("warns that an untested judge will not count in gates", () => {
    expect(r.problems.some((p) => p.level === "warning" && p.rule === "judge_trusted" && p.message.includes("missed_refund"))).toBe(true);
  });
  it("notes that judge checks are not run by --deep", () => {
    expect(r.problems.filter((p) => p.rule === "judge_not_run").length).toBe(2);
  });
  it("counts files", () => {
    expect(r.files).toBeGreaterThanOrEqual(12);
  });
});

describe("bad fixture", () => {
  const r = validateEvals(bad, { deep: true });
  const rules = new Set(r.problems.filter((p) => p.level === "error").map((p) => p.rule));
  const msgs = r.problems.map((p) => `${p.level} ${p.file}: ${p.message}`);
  const has = (rule: string, text: string) =>
    r.problems.some((p) => p.rule === rule && p.message.includes(text));

  it("exits with errors", () => expect(r.errors).toBeGreaterThan(0));
  it("catches few-shot leakage into the test split", () => expect(has("no_leakage", "tr_0001")).toBe(true));
  it("catches a check on a missing failure mode", () => expect(has("failure_mode_exists", "rudeness")).toBe(true));
  it("catches a check on a retired failure mode", () => expect(has("failure_mode_not_retired", "old_mode")).toBe(true));
  it("catches a missing reference solution", () => expect(has("reference_exists", "refund_business_002")).toBe(true));
  it("catches a suite listing a task that does not exist", () => expect(has("task_exists", "ghost_task")).toBe(true));
  it("catches a name that differs from its file name", () => expect(has("name_matches_file", "refund_missed")).toBe(true));
  it("flags a prompt edited after calibration as stale", () => expect(has("prompt_hash", "stale")).toBe(true));
  it("--deep catches a reference solution that fails its outcome check", () =>
    expect(has("reference_passes", "refunds.status")).toBe(true));
  it("--deep catches a reference solution that fails its code check", () =>
    expect(has("reference_passes", "identity_verified.py returned False")).toBe(true));
  it("--deep does not flag a required tool that is present", () => expect(has("reference_passes", "never called")).toBe(false));
  it("reports every problem with a file and a message", () => {
    for (const p of r.problems) { expect(p.file).toBeTruthy(); expect(p.message).toBeTruthy(); }
    expect(rules.size).toBeGreaterThanOrEqual(8);
    expect(msgs.length).toBeGreaterThan(0);
  });
});

describe("edge cases", () => {
  it("a missing directory is one error", () => {
    const r = validateEvals(join(fixtures, "nope"));
    expect(r.errors).toBe(1);
  });
});
