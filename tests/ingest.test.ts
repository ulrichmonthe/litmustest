import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { initEvals, detectJsonlSource } from "../packages/cli/src/init.ts";
import { ingest } from "../packages/cli/src/ingest.ts";
import { jsonlLineToTrace } from "../packages/cli/src/adapters/jsonl.ts";
import { traceView, viewText } from "../packages/cli/src/trace_view.ts";
import { kmeans, tfidf } from "../packages/cli/src/cluster.ts";
import { validateEvals } from "../packages/cli/src/validate.ts";
import { SchemaSet } from "../packages/cli/src/schemas.ts";

const schemas = new SchemaSet();
const EXAMPLE_JSONL = join(import.meta.dirname, "..", "examples", "support-agent", "traces", "support.jsonl");
const tmp = () => mkdtempSync(join(tmpdir(), "litmustest-"));

describe("jsonl adapter", () => {
  it("builds a valid trace from a minimal line and warns about what it filled", () => {
    const r = jsonlLineToTrace({ id: "t1", input: "hi", output: "hello" }, { ingestedAt: new Date("2026-10-27T00:00:00Z") });
    expect(schemas.check("trace", r.trace)).toEqual([]);
    expect(r.warnings).toContain("no timestamp; using ingest time");
    expect(r.warnings).toContain("no model");
    expect(r.warnings.some((w) => w.startsWith("no messages"))).toBe(true);
    const v = traceView(r.trace);
    expect(v.turns.map((t) => t.role)).toEqual(["user", "agent"]);
    expect(v.turns[1]!.content).toBe("hello");
  });
  it("places tool calls on the turn that made them, in order", () => {
    const r = jsonlLineToTrace({ id: "t2", input: "refund", output: "done", model: "m-1", timestamp: "2026-10-01T10:00:00Z",
      messages: [{ role: "user", content: "refund" }, { role: "assistant", content: "checking" }, { role: "user", content: "ok" }, { role: "assistant", content: "done" }],
      tool_calls: [{ id: "a", name: "verify_identity", arguments: { email: "x" }, result: { verified: true }, turn: 0 }, { id: "b", name: "process_refund", arguments: {}, result: { error: "nope" }, turn: 1 }] });
    expect(r.warnings).toEqual([]);
    expect(schemas.check("trace", r.trace)).toEqual([]);
    const v = traceView(r.trace);
    expect(v.calls.map((c) => [c.name, c.ok])).toEqual([["verify_identity", true], ["process_refund", false]]);
    expect(v.turns.map((t) => t.role)).toEqual(["user", "tool", "agent", "user", "tool", "agent"]);
    expect(v.model).toBe("m-1");
  });
  it("drops tool calls that point at a turn that does not exist, with a warning", () => {
    const r = jsonlLineToTrace({ id: "t3", input: "a", output: "b", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], tool_calls: [{ name: "x", turn: 4 }] });
    expect(r.warnings.some((w) => w.includes("turns 4"))).toBe(true);
    expect(traceView(r.trace).calls).toEqual([]);
  });
});

describe("clustering", () => {
  it("is deterministic and separates obvious groups", () => {
    const docs = [...Array(10).fill("refund duplicate charge card"), ...Array(10).fill("invoice copy vat number accounting")].map((d, i) => `${d} ${i % 3}`);
    const a = kmeans(tfidf(docs), 2, 7), b = kmeans(tfidf(docs), 2, 7);
    expect(a.assignments).toEqual(b.assignments);
    expect(new Set(a.assignments.slice(0, 10)).size).toBe(1);
    expect(new Set(a.assignments.slice(10)).size).toBe(1);
    expect(a.assignments[0]).not.toBe(a.assignments[10]);
    expect(a.terms.flat()).toContain("refund");
  });
  it("copes with more clusters than documents", () => {
    const r = kmeans(tfidf(["a b c", "d e f"]), 8, 1);
    expect(r.centroids.length).toBe(2);
  });
});

describe("init", () => {
  it("scaffolds evals/ with a valid config, folders, README and suites, and detects a JSONL source", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, "logs"));
    writeFileSync(join(cwd, "logs", "prod.jsonl"), JSON.stringify({ id: "x", input: "a", output: "b" }) + "\n");
    expect(detectJsonlSource(cwd)).toBe("logs/prod.jsonl");
    const r = initEvals({ cwd, project: "My App" });
    expect(r.source).toBe("logs/prod.jsonl");
    expect(existsSync(join(cwd, "evals", "litmustest.yaml"))).toBe(true);
    expect(existsSync(join(cwd, "evals", "README.md"))).toBe(true);
    for (const d of ["failure_modes", "tasks", "refs", "graders/code", "graders/judges", "labels", "datasets/traces", "suites", "runs", "batches"]) expect(existsSync(join(cwd, "evals", d)), d).toBe(true);
    const cfg = parseYaml(readFileSync(join(cwd, "evals", "litmustest.yaml"), "utf8"));
    expect(cfg.project).toBe("my_app");
    expect(cfg.sources.traces.path).toBe("logs/prod.jsonl");
    const v = validateEvals(join(cwd, "evals"));
    expect(v.problems.filter((p) => p.level === "error")).toEqual([]);
  });
  it("refuses to overwrite an existing config without --force", () => {
    const cwd = tmp();
    initEvals({ cwd });
    expect(() => initEvals({ cwd })).toThrow(/already exists/);
    expect(() => initEvals({ cwd, force: true })).not.toThrow();
  });
});

describe("ingest", () => {
  it("normalizes the example's traces, clusters them and writes a valid batch with coverage", () => {
    const cwd = tmp();
    initEvals({ cwd, source: EXAMPLE_JSONL });
    const r = ingest({ cwd, evalsDir: "evals", source: EXAMPLE_JSONL, size: 30, clusters: 6, seed: 3, batch: "first", now: new Date("2026-10-27T10:00:00Z") });
    expect(r.traces).toBe(300);
    expect(r.written).toBe(300);
    expect(r.invalid).toEqual([]);
    expect(readdirSync(join(cwd, "evals", "datasets", "traces")).filter((f) => f.endsWith(".json")).length).toBe(300);
    const batch = parseYaml(readFileSync(r.batchFile, "utf8"));
    expect(schemas.check("batch", batch)).toEqual([]);
    expect(batch.items.length).toBe(30);
    expect(batch.items.filter((i: { reason: string }) => i.reason === "representative").length).toBe(6);
    expect(batch.coverage.clusters.reduce((a: number, c: { size: number }) => a + c.size, 0)).toBe(300);
    expect(batch.coverage.clusters.reduce((a: number, c: { sampled: number }) => a + c.sampled, 0)).toBe(30);
    const v = validateEvals(join(cwd, "evals"));
    expect(v.problems.filter((p) => p.level === "error")).toEqual([]);
    // second run: nothing rewritten, same batch
    const r2 = ingest({ cwd, evalsDir: "evals", source: EXAMPLE_JSONL, size: 30, clusters: 6, seed: 3, batch: "first", now: new Date("2026-10-27T11:00:00Z") });
    expect(r2.written).toBe(0); expect(r2.skipped).toBe(300);
    expect((r2.batch as { items: unknown[] }).items).toEqual(batch.items);
  });
  it("reports invalid lines and still writes the batch for the rest", () => {
    const cwd = tmp();
    initEvals({ cwd });
    writeFileSync(join(cwd, "mixed.jsonl"), [JSON.stringify({ id: "ok1", input: "a", output: "b" }), "{not json", JSON.stringify({ input: "no id", output: "x" }), JSON.stringify({ id: "ok2", input: "c", output: "d" })].join("\n"));
    const r = ingest({ cwd, evalsDir: "evals", source: "mixed.jsonl", size: 5, clusters: 2 });
    expect(r.traces).toBe(2);
    expect(r.invalid.length).toBe(2);
    expect(r.warnings.get("no model")).toBe(2);
  });
  it("a batch naming a missing trace fails validation", () => {
    const cwd = tmp();
    initEvals({ cwd });
    writeFileSync(join(cwd, "evals", "batches", "b.yaml"), "name: b\ncreated: 2026-10-27T00:00:00Z\nsource: x\nsampler: { size: 1, clusters: 1, seed: 1 }\nitems: [{ trace_id: ghost, cluster: 0, reason: random }]\ncoverage: { total_traces: 1, sampled: 1, clusters: [] }\n");
    const v = validateEvals(join(cwd, "evals"));
    expect(v.problems.some((p) => p.rule === "trace_exists" && p.message.includes("ghost"))).toBe(true);
  });
  it("viewText carries user text, agent text, tools and metadata", () => {
    const r = jsonlLineToTrace({ id: "t", input: "charged twice", output: "refunded", tool_calls: [{ name: "process_refund", turn: 0 }], metadata: { persona: "frustrated" }, messages: [{ role: "user", content: "charged twice" }, { role: "assistant", content: "refunded" }] });
    const text = viewText(traceView(r.trace));
    expect(text).toContain("charged twice"); expect(text).toContain("tool_process_refund"); expect(text).toContain("persona_frustrated");
  });
});
