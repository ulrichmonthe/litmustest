// B2: transcript storage. s3, gcs, braintrust and langfuse are exercised against an in-memory fake of each service's
// HTTP surface (the same way tests/phase4.test.ts tests the pull adapters); no live bucket or account is involved.
// The SigV4 signer is checked against the signatures AWS publishes in its S3 API reference.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run } from "../packages/cli/src/run.ts";
import { signV4 } from "../packages/cli/src/storage/sigv4.ts";
import { isRemoteRef, openStore, parseRef, type StoreFetch } from "../packages/cli/src/storage/index.ts";
import { dispute, loadTrial, trial, transcriptsIndex } from "../packages/cli/src/server/transcripts.ts";
import { App } from "../packages/cli/src/server/app.ts";
import { transcriptLinks, workflow, writeWorkflow, WORKFLOW } from "../packages/cli/src/ci.ts";
import { computeCoverage } from "../packages/cli/src/coverage.ts";
import { SchemaSet } from "../packages/cli/src/schemas.ts";
import type { Comparison } from "../packages/cli/src/compare.ts";
vi.setConfig({ testTimeout: 120_000 });

const EXAMPLE = join(import.meta.dirname, "..", "examples", "support-agent", "evals");
const FAKE = join(import.meta.dirname, "fixtures", "agents", "fake_agent.mjs");
const judge = async () => JSON.stringify({ critique: "fine", result: "Pass" });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Call = { method: string; url: string; headers: Record<string, string>; body?: string };

/** An object store: PUT stores, GET and HEAD read, anything unknown is 404. Records every request. */
function bucket() {
  const objects = new Map<string, string>(); const calls: Call[] = []; let fail: string | null = null;
  const fetch: StoreFetch = async (url, init) => {
    const method = init?.method ?? "GET"; calls.push({ method, url, headers: init?.headers ?? {}, body: init?.body });
    if (fail && url.includes(fail)) return { ok: false, status: 500, text: async () => "InternalError" };
    if (method === "PUT") { objects.set(url, init?.body ?? ""); return { ok: true, status: 200, text: async () => "" }; }
    const hit = objects.get(url);
    return hit === undefined ? { ok: false, status: 404, text: async () => "NoSuchKey" } : { ok: true, status: 200, text: async () => (method === "HEAD" ? "" : hit) };
  };
  return { objects, calls, fetch, failOn: (s: string | null) => { fail = s; } };
}
/** A copy of the example with the fake agent and the given storage.transcripts block. */
function fixture(transcripts: string): { repo: string; evals: string } {
  const repo = mkdtempSync(join(tmpdir(), "litmustest-store-")); const evals = join(repo, "evals");
  cpSync(EXAMPLE, evals, { recursive: true });
  for (const f of readdirSync(join(evals, "runs"))) rmSync(join(evals, "runs", f));
  const cfg = readFileSync(join(evals, "litmustest.yaml"), "utf8").replace(/command: .*\n(\s+\{trial_dir\}\n)?/, `command: node ${FAKE}\n`).replace(/  transcripts:\n    backend: local\n    path: .*\n/, `  transcripts:\n${transcripts}`);
  writeFileSync(join(evals, "litmustest.yaml"), cfg);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return { repo, evals };
}
const AWS = { AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };

describe("SigV4 signer", () => {
  // "Authenticating Requests: Using the Authorization Header (AWS Signature Version 4)", examples in the Amazon S3 API reference
  const c = { region: "us-east-1", accessKeyId: AWS.AWS_ACCESS_KEY_ID, secretAccessKey: AWS.AWS_SECRET_ACCESS_KEY, now: new Date("2013-05-24T00:00:00Z") };
  it("matches AWS's published signatures for GET object, list objects and get lifecycle", () => {
    const get = signV4({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: { Range: "bytes=0-9" }, ...c });
    expect(get.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(get["x-amz-date"]).toBe("20130524T000000Z"); expect(get["x-amz-content-sha256"]).toBe(sha("")); expect(get.host).toBeUndefined();
    expect(signV4({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", ...c }).authorization).toContain("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
    expect(signV4({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/?lifecycle", ...c }).authorization).toContain("Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
  });
  it("signs the session token and the body hash when there are any", () => {
    const h = signV4({ method: "PUT", url: "https://b.s3.eu-west-1.amazonaws.com/a/b.json", body: "{}", region: "eu-west-1", accessKeyId: "id", secretAccessKey: "secret", sessionToken: "tok", now: c.now });
    expect(h["x-amz-security-token"]).toBe("tok"); expect(h["x-amz-content-sha256"]).toBe(sha("{}")); expect(h.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token");
  });
});

describe("transcript refs", () => {
  it("every ref ends in run/task/n, whatever the store", () => {
    expect(parseRef("local:run_1/task_a/2")).toEqual({ scheme: "local", run: "run_1", task: "task_a", n: 2 });
    expect(parseRef("s3://acme/evals/tr/run_1/task_a/2")).toEqual({ scheme: "s3", run: "run_1", task: "task_a", n: 2 });
    expect(parseRef("braintrust:proj_1/run_1/task_a/5")).toMatchObject({ scheme: "braintrust", run: "run_1", n: 5 });
    expect(parseRef("nonsense")).toBeNull(); expect(parseRef("local:run/task/x")).toBeNull();
    expect(isRemoteRef("gs://b/run/t/1")).toBe(true); expect(isRemoteRef("local:run/t/1")).toBe(false); expect(isRemoteRef(undefined)).toBe(false);
  });
});

describe("local store", () => {
  it("is the directory beside evals/ and needs no network", async () => {
    const { repo, evals } = fixture("    backend: local\n    path: .litmustest/transcripts\n");
    const s = openStore(evals, { fetch: async () => { throw new Error("no network for local"); } });
    expect(s.backend).toBe("local"); expect(s.root).toBe(join(repo, ".litmustest", "transcripts")); expect(s.ref("r", "t", 1)).toBe("local:r/t/1");
    await s.put("r", "t", 1, "trial.json", "{}");
    expect(readFileSync(join(repo, ".litmustest", "transcripts", "r", "t", "1", "trial.json"), "utf8")).toBe("{}");
    expect(await s.get("r", "t", 1, "trial.json")).toBe("{}"); expect(await s.get("r", "t", 1, "grades.json")).toBeNull(); expect(await s.has("r", "t", 1)).toBe(true); expect(await s.has("r", "t", 2)).toBe(false);
    expect(await s.push("r", "t", 1)).toEqual([]); expect(await s.pull("r", "t", 1)).toEqual({ ok: true });
  });
  it("langsmith and unknown backends are refused with a clear message", () => {
    expect(() => openStore(fixture("    backend: langsmith\n").evals)).toThrow(/langsmith is not written yet/);
    expect(() => openStore(fixture("    backend: azure\n").evals)).toThrow(/not one of local, s3, gcs, braintrust, langfuse/);
    expect(() => openStore(fixture("    backend: s3\n").evals)).toThrow(/needs storage\.transcripts\.bucket/);
  });
});

describe("s3 and gcs stores (against a fake bucket)", () => {
  it("s3: signed virtual-hosted requests, a round trip, 404 as null, and credentials from the environment only", async () => {
    const b = bucket(); const { repo, evals } = fixture("    backend: s3\n    bucket: acme-evals\n    prefix: support/tr\n    region: eu-west-1\n");
    const s = openStore(evals, { fetch: b.fetch, env: { ...AWS, AWS_SESSION_TOKEN: "sess" }, now: () => new Date("2026-11-11T10:00:00Z") });
    expect(s.backend).toBe("s3"); expect(s.root).toBe(join(repo, ".litmustest", "cache", "transcripts"));
    expect(s.ref("run_1", "task_a", 2)).toBe("s3://acme-evals/support/tr/run_1/task_a/2");
    await s.put("run_1", "task_a", 2, "trial.json", '{"output":"hi"}');
    const put = b.calls[0]!;
    expect(put.method).toBe("PUT"); expect(put.url).toBe("https://acme-evals.s3.eu-west-1.amazonaws.com/support/tr/run_1/task_a/2/trial.json"); expect(put.body).toBe('{"output":"hi"}');
    expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261111\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(put.headers["x-amz-content-sha256"]).toBe(sha('{"output":"hi"}')); expect(put.headers["x-amz-date"]).toBe("20261111T100000Z"); expect(put.headers["content-type"]).toBe("application/json"); expect(put.headers["x-amz-security-token"]).toBe("sess");
    // the signature is the one the same request signs to when recomputed from what was sent
    expect(signV4({ method: "PUT", url: put.url, body: put.body, headers: { "content-type": "application/json" }, region: "eu-west-1", accessKeyId: AWS.AWS_ACCESS_KEY_ID, secretAccessKey: AWS.AWS_SECRET_ACCESS_KEY, sessionToken: "sess", now: new Date("2026-11-11T10:00:00Z") }).authorization).toBe(put.headers.authorization);
    expect(await s.remote!.get("run_1", "task_a", 2, "trial.json")).toBe('{"output":"hi"}'); expect(await s.remote!.get("run_1", "task_a", 2, "grades.json")).toBeNull();
    expect(await s.remote!.has("run_1", "task_a", 2)).toBe(true); expect(await s.remote!.has("run_1", "task_a", 3)).toBe(false); expect(b.calls.at(-1)!.method).toBe("HEAD");
    expect(s.url("run_1", "task_a", 2)).toContain("s3.console.aws.amazon.com/s3/buckets/acme-evals?region=eu-west-1&prefix=support%2Ftr%2Frun_1%2Ftask_a%2F2%2F");
    b.failOn("task_b"); await expect(s.remote!.get("run_1", "task_b", 1, "trial.json")).rejects.toThrow(/s3 GET support\/tr\/run_1\/task_b\/1\/trial\.json: HTTP 500/);
    await expect(openStore(evals, { fetch: b.fetch, env: {} }).remote!.get("r", "t", 1, "trial.json")).rejects.toThrow(/needs AWS_ACCESS_KEY_ID in the environment/);
  });
  it("reads through a local cache: the second read does not touch the network", async () => {
    const b = bucket(); const { repo, evals } = fixture("    backend: s3\n    path: s3://acme-evals/tr\n");
    const env = { ...AWS, AWS_REGION: "us-west-2" };
    await openStore(evals, { fetch: b.fetch, env }).remote!.put("run_1", "task_a", 1, "trial.json", "{}"); // someone else's upload: not in this machine's cache
    expect(b.calls[0]!.url).toBe("https://acme-evals.s3.us-west-2.amazonaws.com/tr/run_1/task_a/1/trial.json");
    const s = openStore(evals, { fetch: b.fetch, env }); const before = b.calls.length;
    expect(s.cached("run_1", "task_a", 1, "trial.json")).toBeNull();
    expect(await s.get("run_1", "task_a", 1, "trial.json")).toBe("{}"); expect(b.calls.length).toBe(before + 1);
    expect(await s.get("run_1", "task_a", 1, "trial.json")).toBe("{}"); expect(b.calls.length).toBe(before + 1);
    expect(readFileSync(join(repo, ".litmustest", "cache", "transcripts", "run_1", "task_a", "1", "trial.json"), "utf8")).toBe("{}");
    expect(await s.pull("run_1", "task_a", 1)).toEqual({ ok: true }); // the three files that are not there are asked for once each and stay missing
    b.failOn("task_z"); expect(await s.pull("run_1", "task_z", 1)).toMatchObject({ ok: false, error: expect.stringContaining("HTTP 500") });
  });
  it("gcs: the S3-compatible XML API at storage.googleapis.com with HMAC keys and region auto; a custom endpoint is path-style", async () => {
    const b = bucket(); const g = openStore(fixture("    backend: gcs\n    bucket: acme-evals\n    prefix: tr\n").evals, { fetch: b.fetch, env: { GCS_ACCESS_KEY_ID: "GOOG1EXAMPLE", GCS_SECRET_ACCESS_KEY: "s" }, now: () => new Date("2026-11-11T10:00:00Z") });
    await g.put("run_1", "task a", 1, "stdout.txt", "hello"); // the task id is made safe for a key
    expect(b.calls[0]!.url).toBe("https://storage.googleapis.com/acme-evals/tr/run_1/taska/1/stdout.txt"); expect(b.calls[0]!.headers.authorization).toContain("Credential=GOOG1EXAMPLE/20261111/auto/s3/aws4_request"); expect(b.calls[0]!.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(g.ref("run_1", "task_a", 1)).toBe("gs://acme-evals/tr/run_1/task_a/1"); expect(await g.remote!.get("run_1", "task a", 1, "stdout.txt")).toBe("hello");
    await expect(openStore(fixture("    backend: gcs\n    bucket: b\n").evals, { fetch: b.fetch, env: AWS }).remote!.has("r", "t", 1)).rejects.toThrow(/needs GCS_ACCESS_KEY_ID/);
    const m = openStore(fixture("    backend: s3\n    bucket: evals\n    endpoint: http://127.0.0.1:9000/\n").evals, { fetch: b.fetch, env: AWS });
    await m.put("r", "t", 1, "trial.json", "{}"); expect(b.calls.at(-1)!.url).toBe("http://127.0.0.1:9000/evals/r/t/1/trial.json"); expect(m.url("r", "t", 1)).toBeUndefined();
  });
});

describe("langfuse and braintrust stores (against fakes of their APIs)", () => {
  it("langfuse: one trace per trial tagged with run, task and trial; each file is a span; reads go back by the trace id", async () => {
    const traces = new Map<string, any>(); const calls: Call[] = [];
    const fetch: StoreFetch = async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url, headers: init?.headers ?? {}, body: init?.body });
      if (url.endsWith("/api/public/ingestion")) {
        for (const e of JSON.parse(init!.body!).batch) {
          if (e.type === "trace-create") traces.set(e.body.id, { ...(traces.get(e.body.id) ?? { observations: [] }), ...e.body });
          if (e.type === "span-create") { const t = traces.get(e.body.traceId); t.observations = [...t.observations.filter((o: any) => o.id !== e.body.id), e.body]; }
        }
        return { ok: true, status: 207, text: async () => JSON.stringify({ successes: [], errors: [] }) };
      }
      const id = url.split("/api/public/traces/")[1]!; const t = traces.get(id);
      return t ? { ok: true, status: 200, text: async () => JSON.stringify(t) } : { ok: false, status: 404, text: async () => "not found" };
    };
    const s = openStore(fixture("    backend: langfuse\n").evals, { fetch, env: { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_HOST: "https://lf.example/" } });
    expect(s.ref("run_1", "task_a", 2)).toBe("langfuse:run_1/task_a/2");
    await s.put("run_1", "task_a", 2, "trial.json", JSON.stringify({ output: "Refunded.", transcript: [{ role: "user", content: "charged twice" }] }));
    await s.put("run_1", "task_a", 2, "grades.json", '{"pass":true}');
    expect(calls[0]!.url).toBe("https://lf.example/api/public/ingestion"); expect(calls[0]!.headers.Authorization).toBe("Basic " + Buffer.from("pk:sk").toString("base64"));
    expect(traces.size).toBe(1); const t = [...traces.values()][0];
    expect(t.id).toMatch(/^[0-9a-f]{32}$/); expect(t.tags).toEqual(["litmustest", "run:run_1", "task:task_a", "trial:2"]); expect(t.sessionId).toBe("run_1"); expect(t.input).toBe("charged twice"); expect(t.output).toBe("Refunded.");
    expect(t.observations.map((o: any) => o.name).sort()).toEqual(["grades.json", "trial.json"]);
    expect(await s.remote!.get("run_1", "task_a", 2, "grades.json")).toBe('{"pass":true}'); expect(await s.remote!.get("run_1", "task_a", 2, "stderr.txt")).toBeNull(); expect(await s.remote!.get("run_1", "task_a", 3, "trial.json")).toBeNull();
    expect(await s.remote!.has("run_1", "task_a", 2)).toBe(true); expect(s.url("run_1", "task_a", 2)).toBe(`https://lf.example/trace/${t.id}`);
    await expect(openStore(fixture("    backend: langfuse\n").evals, { fetch, env: {} }).remote!.put("r", "t", 1, "trial.json", "{}")).rejects.toThrow(/needs LANGFUSE_PUBLIC_KEY/);
    const refusing: StoreFetch = async () => ({ ok: true, status: 207, text: async () => JSON.stringify({ successes: [], errors: [{ id: "x", status: 400, message: "invalid" }] }) });
    await expect(openStore(fixture("    backend: langfuse\n").evals, { fetch: refusing, env: { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" } }).remote!.put("r", "t", 1, "trial.json", "{}")).rejects.toThrow(/Langfuse refused trial\.json/);
  });
  it("braintrust: a root event tagged with run, task and trial and one child event per file; reads go back by event id", async () => {
    const events = new Map<string, any>(); const calls: Call[] = [];
    const fetch: StoreFetch = async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url, headers: init?.headers ?? {}, body: init?.body });
      if (url.endsWith("/insert")) { for (const e of JSON.parse(init!.body!).events) events.set(e.id, { ...(e._is_merge ? events.get(e.id) : {}), ...e }); return { ok: true, status: 200, text: async () => JSON.stringify({ row_ids: [] }) }; }
      if (url.endsWith("/btql")) { const id = /filter: id = '([^']+)'/.exec(JSON.parse(init!.body!).query)![1]!; const e = events.get(id); return { ok: true, status: 200, text: async () => JSON.stringify({ data: e ? [e] : [] }) }; }
      return { ok: false, status: 404, text: async () => "" };
    };
    const s = openStore(fixture("    backend: braintrust\n    project: proj_1\n").evals, { fetch, env: { BRAINTRUST_API_KEY: "k" } });
    expect(s.ref("run_1", "task_a", 2)).toBe("braintrust:proj_1/run_1/task_a/2"); expect(parseRef(s.ref("run_1", "task_a", 2))).toMatchObject({ run: "run_1", task: "task_a", n: 2 });
    await s.put("run_1", "task_a", 2, "trial.json", '{"output":"Sent."}'); await s.put("run_1", "task_a", 2, "stderr.txt", "warn");
    expect(calls[0]!.url).toBe("https://api.braintrust.dev/v1/project_logs/proj_1/insert"); expect(calls[0]!.headers.Authorization).toBe("Bearer k");
    const root = events.get("litmustest:run_1/task_a/2"); expect(root.tags).toEqual(["litmustest", "run:run_1", "task:task_a", "trial:2"]); expect(root.output).toBe("Sent."); expect(root.metadata.litmustest).toEqual({ run: "run_1", task: "task_a", trial: 2 });
    expect(events.get("litmustest:run_1/task_a/2/stderr.txt")).toMatchObject({ root_span_id: "litmustest:run_1/task_a/2", span_parents: ["litmustest:run_1/task_a/2"], input: "warn" });
    expect(await s.remote!.get("run_1", "task_a", 2, "trial.json")).toBe('{"output":"Sent."}'); expect(await s.remote!.get("run_1", "task_a", 2, "grades.json")).toBeNull(); expect(await s.remote!.has("run_1", "task_a", 2, "stderr.txt")).toBe(true);
    expect(calls.at(-1)!.url).toBe("https://api.braintrust.dev/btql"); expect(JSON.parse(calls.at(-1)!.body!).query).toContain("from: project_logs('proj_1')");
    expect(() => openStore(fixture("    backend: braintrust\n").evals, { fetch, env: { BRAINTRUST_API_KEY: "k" } }).ref("r", "t", 1)).toThrow(/needs BRAINTRUST_PROJECT_ID/);
  });
});

describe("the runner and the readers on a remote store", () => {
  it("uploads each trial after grading, records the store's address, and the Transcript page reads it back on a machine with no local copy", async () => {
    const b = bucket(); const { repo, evals } = fixture("    backend: s3\n    bucket: acme-evals\n    prefix: tr\n    region: eu-west-1\n");
    const storage = { fetch: b.fetch, env: AWS };
    const r = await run({ evalsDir: evals, tasks: ["duplicate_charge_business", "refund_ghost_account_frustrated"], trials: 1, judgeAsk: judge, runId: "run_s3", storage });
    const s = r.summary as any;
    expect(s.tasks.duplicate_charge_business.trials[0].transcript_ref).toBe("s3://acme-evals/tr/run_s3/duplicate_charge_business/1");
    expect(new SchemaSet().check("run_summary", s)).toEqual([]); expect(r.warnings.some((w) => w.includes("not uploaded"))).toBe(false);
    const keys = [...b.objects.keys()].map((u) => u.replace("https://acme-evals.s3.eu-west-1.amazonaws.com/tr/run_s3/", "")).sort();
    expect(keys).toEqual(["duplicate_charge_business/1/grades.json", "duplicate_charge_business/1/stderr.txt", "duplicate_charge_business/1/stdout.txt", "duplicate_charge_business/1/trial.json", "refund_ghost_account_frustrated/1/grades.json", "refund_ghost_account_frustrated/1/stderr.txt", "refund_ghost_account_frustrated/1/stdout.txt", "refund_ghost_account_frustrated/1/trial.json"]);
    expect(JSON.parse(b.objects.get("https://acme-evals.s3.eu-west-1.amazonaws.com/tr/run_s3/refund_ghost_account_frustrated/1/grades.json")!).pass).toBe(false);
    // the trial ran in the cache directory; nothing was written to the local store path
    expect(existsSync(join(repo, ".litmustest", "cache", "transcripts", "run_s3", "duplicate_charge_business", "1", "support.sqlite"))).toBe(true); expect(existsSync(join(repo, ".litmustest", "transcripts"))).toBe(false);
    // another machine: same repo, empty cache
    rmSync(join(repo, ".litmustest"), { recursive: true, force: true });
    const app = new App(evals);
    const index = transcriptsIndex(app, "run_s3").body as any;
    expect(index.tasks.every((t: any) => t.trials[0].available)).toBe(true); // the ref says where it is; no request was needed to list
    expect(loadTrial(evals, "run_s3", "refund_ghost_account_frustrated", 1).trialData).toBeNull(); // not here yet
    const before = b.calls.length;
    const page = (await trial(app, "run_s3", "refund_ghost_account_frustrated", 1, storage)).body as any;
    expect(page.trial.output).toBeTruthy(); expect(page.view.turns.length).toBeGreaterThan(1); expect(page.grades.find((g: any) => g.check === "end_state").pass).toBe(false);
    expect(page.outcome.find((o: any) => o.path === "refunds.status").actual).toBe("none");
    expect(page.store).toMatchObject({ backend: "s3", ref: "s3://acme-evals/tr/run_s3/refund_ghost_account_frustrated/1" }); expect(page.store.url).toContain("acme-evals");
    expect(b.calls.length - before).toBe(4); // four files fetched once
    await trial(app, "run_s3", "refund_ghost_account_frustrated", 1, storage); expect(b.calls.length - before).toBe(4); // then served from the cache
    expect(existsSync(join(repo, ".litmustest", "cache", "transcripts", "run_s3", "refund_ghost_account_frustrated", "1", "grades.json"))).toBe(true);
    // surface coverage counts calls from transcripts that are on this machine
    expect(computeCoverage(evals, { run: s }).maps.surface.items.some((i) => i.tasks.some((t) => t.via === "called"))).toBe(true);
    // a dispute reads the trial through the store and writes the trace id back to it
    const d = await dispute(app, "run_s3", "duplicate_charge_business", 1, { check: "tone", label: "Fail", note: "too breezy" }, storage);
    expect(d.status).toBe(200); expect(JSON.parse(b.objects.get("https://acme-evals.s3.eu-west-1.amazonaws.com/tr/run_s3/duplicate_charge_business/1/trial.json")!).trace_id).toBe("trial_run_s3_duplicate_charge_business_1");
    // an unreachable store: the page still answers, without the transcript, and says why
    rmSync(join(repo, ".litmustest", "cache"), { recursive: true, force: true }); b.failOn("run_s3");
    const down = (await trial(app, "run_s3", "refund_ghost_account_frustrated", 1, storage)).body as any;
    expect(down.trial).toBeNull(); expect(down.store.error).toContain("HTTP 500"); expect(down.summary.pass).toBe(false);
  });
  it("a failed upload keeps the local copy, warns, and changes no score", async () => {
    const b = bucket(); b.failOn("grades.json"); const { repo, evals } = fixture("    backend: gcs\n    bucket: acme-evals\n");
    const r = await run({ evalsDir: evals, tasks: ["duplicate_charge_business"], trials: 1, judgeAsk: judge, runId: "run_gcs", storage: { fetch: b.fetch, env: { GCS_ACCESS_KEY_ID: "id", GCS_SECRET_ACCESS_KEY: "s" } } });
    expect(r.warnings.find((w) => w.includes("not uploaded"))).toMatch(/1 of 1 transcripts were not uploaded to gcs and exist only in .*cache/);
    expect((r.summary as any).tasks.duplicate_charge_business.strict_pass).toBe(100); expect((r.summary as any).tasks.duplicate_charge_business.trials[0].transcript_ref).toBe("gs://acme-evals/run_gcs/duplicate_charge_business/1");
    expect(existsSync(join(repo, ".litmustest", "cache", "transcripts", "run_gcs", "duplicate_charge_business", "1", "grades.json"))).toBe(true);
  });
});

describe("CI default (decision #6)", () => {
  const flips = (ref: string) => ({ flips: [{ task: "refund_a", suite: "regression", change: "Broke", a: "5 / 5", b: "1 / 5", check: "end_state", transcript_ref: ref }, { task: "fixed_b", suite: "regression", change: "Fixed", a: "0 / 5", b: "5 / 5", check: null, transcript_ref: ref }] }) as unknown as Comparison;
  it("with local transcripts the workflow uploads them as a build artifact; with a remote store it passes that store's credentials instead", () => {
    expect(WORKFLOW).toContain("actions/upload-artifact@v4"); expect(WORKFLOW).toContain("name: litmustest-transcripts"); expect(WORKFLOW).toContain("path: .litmustest/transcripts"); expect(WORKFLOW).toContain("include-hidden-files: true"); expect(WORKFLOW).toContain("if: always()");
    const s3 = workflow({ backend: "s3" });
    expect(s3).not.toContain("upload-artifact"); expect(s3).toContain("AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}"); expect(s3).toContain("AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}"); expect(s3).toMatch(/GH_TOKEN: .*\n +AWS_ACCESS_KEY_ID/);
    expect(workflow({ backend: "langfuse" })).toContain("LANGFUSE_SECRET_KEY: ${{ secrets.LANGFUSE_SECRET_KEY }}");
  });
  it("--write-workflow reads the backend and the transcript path from the config", () => {
    const local = fixture("    backend: local\n    path: build/transcripts\n");
    expect(readFileSync(writeWorkflow(local.repo), "utf8")).toContain("path: build/transcripts");
    const remote = fixture("    backend: s3\n    bucket: acme-evals\n");
    const text = readFileSync(writeWorkflow(remote.repo), "utf8"); expect(text).not.toContain("upload-artifact"); expect(text).toContain("secrets.AWS_ACCESS_KEY_ID");
    expect(() => writeWorkflow(remote.repo)).toThrow(/already exists/);
  });
  it("the PR comment links broken tasks to the artifact in Actions, to the object with a remote store, and to nothing on a laptop", () => {
    const local = fixture("    backend: local\n    path: .litmustest/transcripts\n").evals;
    const inActions = transcriptLinks(local, flips("local:run_9/refund_a/2"), { GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "42", GITHUB_REPOSITORY: "acme/app", GITHUB_SERVER_URL: "https://github.com" });
    expect(inActions).toBe("**Transcripts**\n\n- `refund_a` (broke): `run_9/refund_a/2/` in the [litmustest-transcripts artifact](https://github.com/acme/app/actions/runs/42#artifacts)\n");
    expect(transcriptLinks(local, flips("local:run_9/refund_a/2"), {})).toBe("");
    const s3 = fixture("    backend: s3\n    bucket: acme-evals\n    region: eu-west-1\n").evals;
    expect(transcriptLinks(s3, flips("s3://acme-evals/run_9/refund_a/2"), {})).toMatch(/^\*\*Transcripts\*\*\n\n- `refund_a` \(broke\): \[transcript\]\(https:\/\/s3\.console\.aws\.amazon\.com\/s3\/buckets\/acme-evals\?region=eu-west-1&prefix=run_9%2Frefund_a%2F2%2F\)\n$/);
    const bt = fixture("    backend: braintrust\n    project: proj_1\n").evals;
    expect(transcriptLinks(bt, flips("braintrust:proj_1/run_9/refund_a/2"), {})).toContain("- `refund_a` (broke): `braintrust:proj_1/run_9/refund_a/2`");
    expect(transcriptLinks(local, { flips: [] } as unknown as Comparison, {})).toBe("");
  });
});
