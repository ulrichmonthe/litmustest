// Hosted mode against a fake GitHub API (an injected fetch) and a local bare repository as the remote.
// Nothing here talks to github.com: no GitHub App is registered and nothing is deployed. What this proves is the
// server's side of the contract: the JWT it signs, the calls it makes, the commits and pushes, the gate.
import { execFileSync, spawnSync } from "node:child_process";
import { createVerify, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initEvals } from "../packages/cli/src/init.ts";
import { ingest } from "../packages/cli/src/ingest.ts";
import { serve, type Running } from "../packages/cli/src/serve.ts";
import { App } from "../packages/cli/src/server/app.ts";
import { Hosted, appJwt, hostedFromEnv, normalizeKey, seal, unseal, type HostedFetch } from "../packages/cli/src/server/hosted.ts";
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ROOT = join(import.meta.dirname, "..");
const MAIN = join(ROOT, "packages", "cli", "src", "main.ts");
const EXAMPLE_JSONL = join(ROOT, "examples", "support-agent", "traces", "support.jsonl");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=seed", "-c", "user.email=seed@example.com", ...a], { cwd, encoding: "utf8" }).trim();
const MODE = (definition: string) => `name: tone_mismatch\ndefinition: ${definition}\nseverity: med\ncreated: 2026-10-20\n`;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const SECRET = "0123456789abcdef0123456789abcdef";

/** GitHub, as far as hosted mode uses it. Records every call; checks the App JWT against the public key. */
function fakeGitHub(pub: KeyObject) {
  const people: Record<string, { id: number; name: string; permission: string }> = { ada: { id: 11, name: "Ada L", permission: "write" }, bob: { id: 22, name: "Bob", permission: "admin" }, rae: { id: 33, name: "Rae", permission: "read" }, eve: { id: 44, name: "Eve", permission: "none" } };
  const state = { calls: [] as { method: string; url: string }[], prs: [] as { number: number; head: string; base: string; state: string; title: string; html_url: string }[], tokens: 0, jwts: [] as Record<string, unknown>[], failPr: false };
  const reply = (status: number, data: unknown) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
  const checkJwt = (auth: string) => {
    const [h, p, s] = auth.replace(/^Bearer /, "").split(".");
    if (!createVerify("RSA-SHA256").update(`${h}.${p}`).verify(pub, Buffer.from(s!, "base64url"))) throw new Error("bad JWT signature");
    state.jwts.push({ ...JSON.parse(Buffer.from(h!, "base64url").toString()), ...JSON.parse(Buffer.from(p!, "base64url").toString()) });
  };
  const fetch: HostedFetch = async (url, init = {}) => {
    const method = init.method ?? "GET"; const auth = init.headers?.authorization ?? ""; const u = new URL(url);
    state.calls.push({ method, url: u.pathname + u.search });
    if (u.pathname === "/login/oauth/access_token") { const b = JSON.parse(init.body!); return b.client_id === "Iv1.client" && b.client_secret === "shh" && people[b.code.replace("code_", "")] ? reply(200, { access_token: `utok_${b.code.replace("code_", "")}` }) : reply(200, { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }); }
    if (u.pathname === "/user") { const login = auth.replace("Bearer utok_", ""); return people[login] ? reply(200, { login, id: people[login]!.id, name: people[login]!.name }) : reply(401, { message: "Bad credentials" }); }
    if (u.pathname === "/repos/acme/support/installation") { checkJwt(auth); return reply(200, { id: 77 }); }
    if (u.pathname === "/app/installations/77/access_tokens") { checkJwt(auth); state.tokens++; return reply(201, { token: `inst_${state.tokens}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }); }
    if (!/^Bearer inst_\d+$/.test(auth)) return reply(401, { message: "Bad credentials" });
    if (u.pathname === "/repos/acme/support/pulls" && method === "GET") { const head = u.searchParams.get("head")!.replace("acme:", ""); const st = u.searchParams.get("state"); return reply(200, state.prs.filter((p) => p.head === head && (st === "all" || p.state === st))); }
    if (u.pathname === "/repos/acme/support/pulls" && method === "POST") { if (state.failPr) return reply(422, { message: "Validation Failed" }); const b = JSON.parse(init.body!); const pr = { number: state.prs.length + 1, head: b.head, base: b.base, state: "open", title: b.title, html_url: `https://github.com/acme/support/pull/${state.prs.length + 1}` }; state.prs.push(pr); return reply(201, pr); }
    const pm = /^\/repos\/acme\/support\/collaborators\/([^/]+)\/permission$/.exec(u.pathname);
    if (pm) { const p = people[pm[1]!]?.permission ?? "none"; return reply(200, { permission: p === "none" ? "none" : p === "read" ? "read" : p === "admin" ? "admin" : "write", user: { permissions: { admin: p === "admin", maintain: false, push: p === "admin" || p === "write", triage: false, pull: p !== "none" } } }); }
    return reply(404, { message: `fake GitHub has no ${method} ${u.pathname}` });
  };
  return { fetch, state };
}

let remote: string; let work: string; let peer: string; let h: Hosted; let srv: Running; let gh: ReturnType<typeof fakeGitHub>;
const bare = (...a: string[]) => git(remote, ...a);
interface Res { status: number; body: any; headers: Headers }
const http = async (path: string, o: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}): Promise<Res> => {
  const r = await fetch(srv.url + path, { method: o.method ?? "GET", redirect: "manual", body: o.body === undefined ? undefined : JSON.stringify(o.body), headers: { "content-type": "application/json", ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.origin ? { origin: o.origin } : {}) } });
  const text = await r.text(); let body: unknown = text; try { body = JSON.parse(text); } catch { /* a redirect or a page */ }
  return { status: r.status, body, headers: r.headers };
};
const cookieOf = (r: Res, name: string) => r.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith(`${name}=`)) ?? "";
/** The whole OAuth round trip: /auth/login, GitHub (the fake accepts code_<login>), /auth/callback. */
async function signIn(login: string): Promise<{ cookie: string; last: Res }> {
  const start = await http("/auth/login"); const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const last = await http(`/auth/callback?code=code_${login}&state=${state}`, { cookie: cookieOf(start, "lt_state") });
  return { cookie: cookieOf(last, "lt_session"), last };
}
const put = (cookie: string, path: string, content: string) => http("/api/file", { method: "PUT", cookie, body: { path, content } });
const branchHead = (branch: string, format: string) => bare("log", "-1", `--format=${format}`, branch);

beforeAll(async () => {
  const seed = mkdtempSync(join(tmpdir(), "litmustest-hosted-seed-"));
  git(seed, "init", "-q", "-b", "main");
  initEvals({ cwd: seed, source: EXAMPLE_JSONL });
  ingest({ cwd: seed, evalsDir: "evals", source: EXAMPLE_JSONL, size: 10, clusters: 3, batch: "b1", now: new Date("2026-10-27T10:00:00Z") });
  writeFileSync(join(seed, "evals", "failure_modes", "tone_mismatch.yaml"), MODE("The agent's tone does not match the customer's state at all."));
  writeFileSync(join(seed, ".gitignore"), ".litmustest/\n");
  git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "seed");
  const base = mkdtempSync(join(tmpdir(), "litmustest-hosted-"));
  remote = join(base, "remote.git"); work = join(base, "work"); peer = join(base, "peer");
  execFileSync("git", ["clone", "-q", "--bare", seed, remote]);
  gh = fakeGitHub(publicKey);
  h = await Hosted.start({ repo: "acme/support", workDir: work, remoteUrl: remote, appId: "12345", privateKey: PEM, clientId: "Iv1.client", clientSecret: "shh", sessionSecret: SECRET, fetch: gh.fetch, pollSeconds: 0 });
  srv = await serve({ evalsDir: h.evalsDir, port: 0, host: "127.0.0.1", watch: false, hosted: h });
});
afterAll(async () => { await srv?.close(); });

describe("GitHub App auth", () => {
  it("signs an RS256 JWT as the App and trades it for an installation token, once", () => {
    expect(gh.state.jwts[0]).toMatchObject({ alg: "RS256", typ: "JWT", iss: "12345" });
    const j = gh.state.jwts[0] as { iat: number; exp: number }; expect(j.exp - j.iat).toBeLessThanOrEqual(600);
    expect(gh.state.calls.filter((c) => c.url === "/repos/acme/support/installation").length).toBe(1);
    expect(gh.state.tokens).toBe(1); // cached until it nears expiry
  });
  it("accepts the private key as PEM, as PEM with literal \\n, or base64", () => {
    const now = 1_800_000_000; const verify = (jwt: string) => { const [a, b, s] = jwt.split("."); return createVerify("RSA-SHA256").update(`${a}.${b}`).verify(publicKey, Buffer.from(s!, "base64url")); };
    expect(verify(appJwt("1", PEM, now))).toBe(true);
    expect(verify(appJwt("1", PEM.replace(/\n/g, "\\n"), now))).toBe(true);
    expect(verify(appJwt("1", Buffer.from(PEM).toString("base64"), now))).toBe(true);
    expect(normalizeKey(PEM.replace(/\n/g, "\\n")).trim()).toBe(PEM.trim());
  });
  it("a session cookie is signed: tampered, re-signed with another secret or expired means nobody", () => {
    const t = seal({ login: "ada", exp: 2000 }, SECRET);
    expect(unseal<{ login: string; exp: number }>(t, SECRET, 1000)?.login).toBe("ada");
    expect(unseal(t, SECRET, 2001)).toBeNull();
    expect(unseal(seal({ login: "ada", exp: 2000 }, "another-secret-another-secret-123"), SECRET, 1000)).toBeNull();
    const forged = `${Buffer.from(JSON.stringify({ login: "bob", exp: 2000 })).toString("base64url")}.${t.split(".")[1]}`;
    expect(unseal(forged, SECRET, 1000)).toBeNull();
    expect(unseal("garbage", SECRET, 1000)).toBeNull();
  });
  it("names the missing environment variables", () => {
    expect(() => hostedFromEnv("acme/support", {}, {})).toThrow(/LITMUSTEST_APP_ID, LITMUSTEST_APP_PRIVATE_KEY, LITMUSTEST_APP_CLIENT_ID, LITMUSTEST_APP_CLIENT_SECRET, LITMUSTEST_SESSION_SECRET/);
    expect(() => hostedFromEnv("acme/support", {}, { LITMUSTEST_APP_ID: "1", LITMUSTEST_APP_PRIVATE_KEY: "k", LITMUSTEST_APP_CLIENT_ID: "c", LITMUSTEST_APP_CLIENT_SECRET: "s", LITMUSTEST_SESSION_SECRET: "short" })).toThrow(/at least 32/);
  });
});

describe("the gate", () => {
  it("an unauthenticated write is 401, a read is 401, and a page redirects to sign-in", async () => {
    const w = await put("", "failure_modes/tone_mismatch.yaml", MODE("An edit from nobody in particular, which must not land."));
    expect(w.status).toBe(401); expect(w.body.error).toBe("unauthenticated"); expect(w.body.login).toBe("/auth/login");
    expect((await http("/api/health")).status).toBe(401);
    expect((await http("/api/labels", { method: "POST", body: {} })).status).toBe(401);
    const page = await http("/"); expect(page.status).toBe(302); expect(page.headers.get("location")).toBe("/auth/login");
    expect((await http("/api/health", { cookie: `lt_session=${seal({ login: "ada", id: 11, name: "Ada L", email: "x", exp: 9_999_999_999 }, "not-the-servers-secret-0123456789")}` })).status).toBe(401);
    expect((await http("/healthz")).status).toBe(200);
    expect(bare("branch", "--list", "evals/*")).toBe("");
  });
  it("signs a person in through GitHub and remembers them in a signed, HttpOnly cookie", async () => {
    const start = await http("/auth/login");
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize"); expect(to.searchParams.get("client_id")).toBe("Iv1.client"); expect(to.searchParams.get("redirect_uri")).toBe(`${srv.url}/auth/callback`);
    const { cookie, last } = await signIn("ada");
    expect(last.status).toBe(302); expect(last.headers.get("location")).toBe("/");
    expect(last.headers.getSetCookie().find((c) => c.startsWith("lt_session="))).toMatch(/HttpOnly; SameSite=Lax/);
    expect((await http("/auth/me", { cookie })).body).toMatchObject({ login: "ada", name: "Ada L", repo: "acme/support" });
    const health = await http("/api/health", { cookie }); expect(health.status).toBe(200); expect(health.body.annotator).toBe("ada"); expect(health.body.branch).toBe("main");
  });
  it("refuses a callback with the wrong state, a bad code, and a person with no access to the repository", async () => {
    const start = await http("/auth/login");
    expect((await http("/auth/callback?code=code_ada&state=forged", { cookie: cookieOf(start, "lt_state") })).status).toBe(400);
    expect((await http("/auth/callback?code=code_ada&state=x")).status).toBe(400);
    expect((await signIn("nobody")).last.status).toBe(502);
    const eve = await signIn("eve"); expect(eve.last.status).toBe(403); expect(eve.cookie).toBe("");
  });
  it("a reader may read but not write, and a write from another origin is refused", async () => {
    const rae = (await signIn("rae")).cookie;
    expect((await http("/api/files", { cookie: rae })).status).toBe(200);
    const w = await put(rae, "failure_modes/tone_mismatch.yaml", MODE("A reader's edit, which the repository would refuse too."));
    expect(w.status).toBe(403); expect(w.body.error).toBe("read_only");
    expect((await http("/api/glossary/here", { method: "POST", cookie: rae, body: { items: [] } })).status).not.toBe(403);
    const ada = (await signIn("ada")).cookie;
    const x = await http("/api/file", { method: "PUT", cookie: ada, origin: "https://evil.example", body: { path: "failure_modes/tone_mismatch.yaml", content: MODE("A cross-site write riding on Ada's cookie, refused.") } });
    expect(x.status).toBe(403); expect(x.body.error).toBe("cross_origin");
    expect(bare("branch", "--list", "evals/*")).toBe("");
  });
});

describe("every save is a commit on a pull-request branch", () => {
  let ada: string; let bob: string; let branch: string;
  beforeAll(async () => { ada = (await signIn("ada")).cookie; bob = (await signIn("bob")).cookie; });

  it("a save is committed as the signed-in person, pushed, and opens the pull request", async () => {
    const r = await put(ada, "failure_modes/tone_mismatch.yaml", MODE("The agent's tone does not fit how the customer feels. Fail when curt."));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    branch = bare("branch", "--list", "evals/*").replace(/^\*?\s+/, "");
    expect(branch).toMatch(/^evals\/\d{4}-\d\d-\d\d-tone-mismatch$/); expect(r.body.branch).toBe(branch);
    expect(branchHead(branch, "%an <%ae>")).toBe("Ada L <11+ada@users.noreply.github.com>");
    expect(branchHead(branch, "%cn")).toBe("litmustest");
    expect(branchHead(branch, "%s")).toBe("evals: failure_modes/tone_mismatch.yaml");
    expect(bare("show", `${branch}:evals/failure_modes/tone_mismatch.yaml`)).toContain("Fail when curt.");
    expect(bare("show", "main:evals/failure_modes/tone_mismatch.yaml")).not.toContain("Fail when curt."); // the base is untouched
    expect(gh.state.prs).toHaveLength(1); expect(gh.state.prs[0]).toMatchObject({ head: branch, base: "main", state: "open" });
  });
  it("a second person's save is a second commit on the same branch and no second pull request", async () => {
    const r = await put(bob, "failure_modes/slow_reply.yaml", "name: slow_reply\ndefinition: The agent takes more turns than the request needs.\nseverity: low\ncreated: 2026-11-01\n");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(bare("log", "--format=%an: %s", `main..${branch}`).split("\n")).toEqual(["Bob: evals: failure_modes/slow_reply.yaml", "Ada L: evals: failure_modes/tone_mismatch.yaml"]);
    expect(gh.state.prs).toHaveLength(1);
  });
  it("the tray lists what the branch changes, its commits and the pull request", async () => {
    const p = (await http("/api/pending", { cookie: ada })).body;
    expect(p.hosted).toBe(true); expect(p.branch).toBe(branch); expect(p.commit_branch).toBe(branch); expect(p.base).toBe("main");
    expect(p.files.map((f: { path: string; status: string }) => `${f.status} ${f.path}`)).toEqual(["added evals/failure_modes/slow_reply.yaml", "modified evals/failure_modes/tone_mismatch.yaml"]);
    expect(p.files[1].diff).toContain("+definition: The agent's tone does not fit");
    expect(p.commits.map((c: { author: string }) => c.author)).toEqual(["Bob", "Ada L"]);
    expect(p.pr).toEqual({ number: 1, url: "https://github.com/acme/support/pull/1" });
    expect((await http("/api/health", { cookie: ada })).body.pending).toBe(2);
    const pr = await http("/api/pending/pr", { method: "POST", cookie: ada, body: {} }); expect(pr.status).toBe(200); expect(pr.body.url).toBe("https://github.com/acme/support/pull/1");
    expect(git(work, "status", "--porcelain", "--", "evals")).toBe(""); // nothing waits uncommitted
  });
  it("a label is appended under the signed-in name, whatever the request claims", async () => {
    const trace = (readFileSync(join(work, "evals", "batches", "b1.yaml"), "utf8").match(/trace_id: (\S+)/) ?? [])[1]!;
    const r = await http("/api/labels", { method: "POST", cookie: bob, body: { batch: "b1", trace_id: trace, failure_mode: "overall", label: "Fail", annotator: "mallory" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.label.annotator).toBe("bob");
    expect(branchHead(branch, "%an: %s")).toBe("Bob: evals: labels/b1.jsonl");
    expect(bare("show", `${branch}:evals/labels/b1.jsonl`)).toContain('"annotator":"bob"');
  });
  it("a refused save leaves no commit", async () => {
    const before = branchHead(branch, "%H");
    const r = await put(ada, "failure_modes/tone_mismatch.yaml", "name: tone_mismatch\nseverity: critical\ncreated: 2026-10-20\n");
    expect(r.status).toBe(422);
    expect((await put(ada, "suites/regression.yaml", "name: regression\nkind: regression\ntasks: [ghost_task]\n")).status).toBe(422);
    expect(branchHead(branch, "%H")).toBe(before); expect(git(work, "status", "--porcelain")).toBe("");
  });
  it("someone else's push to other files is taken in and the save still lands", async () => {
    execFileSync("git", ["clone", "-q", "-b", branch, remote, peer]);
    writeFileSync(join(peer, "evals", "failure_modes", "slow_reply.yaml"), "name: slow_reply\ndefinition: The agent takes more turns than the request needs, by a count.\nseverity: low\ncreated: 2026-11-01\n");
    git(peer, "commit", "-qam", "peer: slow_reply"); git(peer, "push", "-q", "origin", branch);
    const r = await put(ada, "failure_modes/tone_mismatch.yaml", MODE("The agent's tone does not fit how the customer feels. Fail when curt or breezy."));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(bare("log", "-2", "--format=%an: %s", branch).split("\n")).toEqual(["Ada L: evals: failure_modes/tone_mismatch.yaml", "seed: peer: slow_reply"]);
    expect(readFileSync(join(work, "evals", "failure_modes", "slow_reply.yaml"), "utf8")).toContain("by a count");
  });
  it("a conflict with someone else's push returns 409, keeps theirs, and the next save works", async () => {
    git(peer, "pull", "-q", "origin", branch);
    writeFileSync(join(peer, "evals", "failure_modes", "tone_mismatch.yaml"), MODE("PEER - the tone is wrong for the customer's mood, decided elsewhere."));
    git(peer, "commit", "-qam", "peer: tone"); git(peer, "push", "-q", "origin", branch);
    const theirs = branchHead(branch, "%H");
    const r = await put(ada, "failure_modes/tone_mismatch.yaml", MODE("ADA - the tone is wrong for the customer's mood, decided here."));
    expect(r.status).toBe(409); expect(r.body.error).toBe("conflict"); expect(r.body.message).toMatch(/Their version was kept/); expect(r.body.resolve).toEqual(["reload"]);
    expect(branchHead(branch, "%H")).toBe(theirs);
    expect(readFileSync(join(work, "evals", "failure_modes", "tone_mismatch.yaml"), "utf8")).toContain("PEER - ");
    expect(git(work, "status", "--porcelain")).toBe(""); expect(git(work, "rev-parse", "HEAD")).toBe(theirs);
    const again = await put(ada, "failure_modes/tone_mismatch.yaml", MODE("ADA - the tone is wrong for the customer's mood, decided after reading theirs."));
    expect(again.status).toBe(200); expect(branchHead(branch, "%an")).toBe("Ada L");
  });
  it("discard is a commit that restores the base, by the person who discarded", async () => {
    const r = await http("/api/pending/discard", { method: "POST", cookie: bob, body: { paths: ["failure_modes/slow_reply.yaml"] } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(branchHead(branch, "%an: %s")).toBe("Bob: evals: discard failure_modes/slow_reply.yaml");
    expect(spawnSync("git", ["cat-file", "-e", `${branch}:evals/failure_modes/slow_reply.yaml`], { cwd: remote }).status).not.toBe(0);
    const p = (await http("/api/pending", { cookie: ada })).body;
    expect(p.files.map((f: { path: string }) => f.path)).not.toContain("evals/failure_modes/slow_reply.yaml");
  });
  it("after the pull request is merged the server returns to the base branch, and the next save opens a new one", async () => {
    bare("update-ref", "refs/heads/main", `refs/heads/${branch}`); bare("update-ref", "-d", `refs/heads/${branch}`); gh.state.prs[0]!.state = "closed";
    await h.refresh();
    const health = (await http("/api/health", { cookie: ada })).body;
    expect(health.branch).toBe("main"); expect(health.pending).toBe(0); expect(git(work, "rev-parse", "HEAD")).toBe(bare("rev-parse", "main"));
    expect((await http("/api/pending/pr", { method: "POST", cookie: ada, body: {} })).status).toBe(409);
    const r = await put(ada, "failure_modes/tone_mismatch.yaml", MODE("The agent's tone does not fit the customer, second round of edits."));
    expect(r.status).toBe(200); expect(r.body.branch).toMatch(/^evals\/\d{4}-\d\d-\d\d-tone-mismatch-2$/);
    expect(gh.state.prs).toHaveLength(2); expect(gh.state.prs[1]).toMatchObject({ head: r.body.branch, state: "open" });
  });
  it("when GitHub refuses the pull request the save says so and a later save opens it", async () => {
    bare("update-ref", "refs/heads/main", `refs/heads/${gh.state.prs[1]!.head}`); bare("update-ref", "-d", `refs/heads/${gh.state.prs[1]!.head}`); gh.state.prs[1]!.state = "closed";
    await h.refresh();
    gh.state.failPr = true;
    const r = await put(ada, "failure_modes/tone_mismatch.yaml", MODE("The agent's tone does not fit the customer, third round of edits."));
    expect(r.status).toBe(502); expect(r.body.error).toBe("push_failed"); expect(r.body.message).toMatch(/could not open the pull request/);
    const pushed = bare("branch", "--list", "evals/*").replace(/^\*?\s+/, ""); expect(bare("show", `${pushed}:evals/failure_modes/tone_mismatch.yaml`)).toContain("third round");
    gh.state.failPr = false;
    await h.refresh(); // the poll: unpushed or PR-less saves are picked up again
    expect(gh.state.prs.at(-1)).toMatchObject({ head: pushed, state: "open" }); expect(h.pr?.number).toBe(gh.state.prs.length);
  });
});

describe("one post-write path", () => {
  it("every writer under src/ reaches the tray through App.wrote, never pending.track directly", () => {
    const src = join(ROOT, "packages", "cli", "src"); const hits: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".ts") && /pending\.track\(/.test(readFileSync(p, "utf8"))) hits.push(p.slice(src.length + 1)); } };
    walk(src);
    expect(hits).toEqual(["server/app.ts"]);
  });
  it("App.wrote tells the backend about a save, a multi-file save and a label; a refused save tells it nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "litmustest-wrote-")); git(dir, "init", "-q", "-b", "main");
    initEvals({ cwd: dir, source: EXAMPLE_JSONL }); ingest({ cwd: dir, evalsDir: "evals", source: EXAMPLE_JSONL, size: 5, clusters: 2, batch: "b1", now: new Date("2026-10-27T10:00:00Z") });
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "seed");
    const seen: string[][] = []; const app = new App(join(dir, "evals"), () => ({ onWrote: (rels) => { seen.push(rels); } }));
    expect(app.putFile("failure_modes/tone_mismatch.yaml", MODE("The agent's tone does not match the customer's state at all.")).status).toBe(200);
    expect(app.putFile("failure_modes/tone_mismatch.yaml", "name: tone_mismatch\n").status).toBe(422);
    expect(app.putFiles([{ path: "failure_modes/a_mode.yaml", content: MODE("First of two files saved as one change, long enough.").replace("tone_mismatch", "a_mode") }, { path: "failure_modes/b_mode.yaml", content: MODE("Second of two files saved as one change, long enough.").replace("tone_mismatch", "b_mode") }]).status).toBe(200);
    const trace = (readFileSync(join(dir, "evals", "batches", "b1.yaml"), "utf8").match(/trace_id: (\S+)/) ?? [])[1]!;
    expect(app.appendLabel("b1", { trace_id: trace, failure_mode: "overall", label: "Pass", annotator: "t" }).status).toBe(200);
    expect(seen).toEqual([["evals/failure_modes/tone_mismatch.yaml"], ["evals/failure_modes/a_mode.yaml", "evals/failure_modes/b_mode.yaml"], ["evals/labels/b1.jsonl"]]);
  });
});

describe("the command", () => {
  it("serve --hosted says what it needs, and the local server refuses to listen beyond this machine", async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LITMUSTEST_")));
    const a = spawnSync(process.execPath, [MAIN, "serve", "--hosted", "--repo", "acme/support"], { encoding: "utf8", env });
    expect(a.status).toBe(1); expect(a.stderr).toMatch(/hosted mode needs LITMUSTEST_APP_ID/);
    expect(spawnSync(process.execPath, [MAIN, "serve", "--hosted"], { encoding: "utf8", env }).stderr).toMatch(/--hosted needs --repo/);
    expect(spawnSync(process.execPath, [MAIN, "serve", "--repo", "acme/support", "--dir", join(work, "evals")], { encoding: "utf8", env }).stderr).toMatch(/--repo goes with --hosted/);
    await expect(serve({ evalsDir: join(work, "evals"), port: 0, host: "0.0.0.0", watch: false })).rejects.toThrow(/only listens on this machine/);
  });
});
