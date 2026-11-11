// Hosted mode (docs/HOSTED.md): the same server over a clone it holds itself, for a team with no local checkout.
// The disk stays, so validation and every route work unchanged; only the git and pending layer is swapped:
//   - the server authenticates as a GitHub App and clones the repository into a work directory;
//   - people sign in with GitHub (OAuth through the same App); a write needs write permission on the repository;
//   - every successful write is a commit on an evals/<slug> branch, authored by the person who made it, pushed,
//     with a pull request opened over REST. Nothing reaches the default branch until a person merges that PR.
// No dependency: node:crypto signs the App JWT and the session cookie, and `fetch` is injectable for the tests.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { App, type Backend, type Reply } from "./app.ts";
import { Git, defaultSlug } from "./git.ts";
import { Pending, VIEWS_FOR, type PendingFile, type PendingState } from "./pending.ts";

export type HostedFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;
export interface Actor { login: string; id: number; name: string; email: string; exp: number }
export interface PullRequest { number: number; url: string }
export interface HostedOptions {
  /** owner/name on GitHub. */
  repo: string;
  /** The evals directory inside the repository. Default evals. */
  dir?: string;
  /** Where the server keeps its clone. Default ~/.litmustest/hosted/<owner>__<name>. */
  workDir?: string;
  /** The branch pull requests target. Default: the remote's default branch. */
  base?: string;
  appId: string; privateKey: string; clientId: string; clientSecret: string; sessionSecret: string;
  /** The address people reach the server at, for the OAuth callback and the cookie's Secure flag. */
  publicUrl?: string;
  apiUrl?: string; githubUrl?: string;
  /** Tests: clone from here (a local bare repository) instead of GitHub. */
  remoteUrl?: string;
  fetch?: HostedFetch; now?: () => number;
  /** Seconds between fetches that pick up merges and other people's pushes. 0 turns the timer off. Default 60. */
  pollSeconds?: number;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const BOT = ["-c", "user.name=litmustest", "-c", "user.email=litmustest@users.noreply.github.com"];
const SESSION_SECONDS = 8 * 3600;
const WRITE = new Set(["PUT", "POST", "PATCH", "DELETE"]);
/** POST routes that only read: they need a signed-in person, not write permission. */
const READ_POSTS = new Set(["/api/glossary/here"]);

/** A private key from the environment: PEM, PEM with literal \n, or the PEM base64-encoded on one line. */
export function normalizeKey(raw: string): string {
  const s = raw.trim();
  if (s.includes("BEGIN")) return s.replace(/\\n/g, "\n");
  return Buffer.from(s, "base64").toString("utf8");
}

/** The JWT a GitHub App signs to speak as itself: RS256, issued a minute ago for clock drift, valid nine minutes. */
export function appJwt(appId: string, privateKey: string, nowSeconds: number): string {
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64u(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${payload}`).sign(normalizeKey(privateKey));
  return `${head}.${payload}.${b64u(sig)}`;
}

/** A signed value for a cookie: base64url(JSON) "." HMAC-SHA256. Not encrypted; it holds nothing secret. */
export function seal(payload: object, secret: string): string { const body = b64u(JSON.stringify(payload)); return `${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`; }
export function unseal<T extends { exp: number }>(token: string | undefined, secret: string, nowSeconds: number): T | null {
  if (!token) return null;
  const [body, sig] = token.split("."); if (!body || !sig) return null;
  const want = createHmac("sha256", secret).update(body).digest(); const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T; return typeof p.exp === "number" && p.exp > nowSeconds ? p : null; } catch { return null; }
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

/** The GitHub REST calls hosted mode makes, each through the injectable fetch. */
export class GitHub {
  private o: HostedOptions; private f: HostedFetch; private api: string; private web: string;
  private installation: number | undefined; private cached: { token: string; expires: number } | undefined;
  constructor(o: HostedOptions) { this.o = o; this.f = o.fetch ?? (globalThis.fetch as unknown as HostedFetch); this.api = (o.apiUrl ?? "https://api.github.com").replace(/\/$/, ""); this.web = (o.githubUrl ?? "https://github.com").replace(/\/$/, ""); }
  private now(): number { return Math.floor((this.o.now?.() ?? Date.now()) / 1000); }
  private async call(method: string, url: string, auth: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const r = await this.f(url, { method, headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "litmustest", authorization: auth, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let data: unknown = null; try { data = await r.json(); } catch { /* no body */ }
    return { status: r.status, data };
  }
  private fail(what: string, r: { status: number; data: unknown }): Error { return new Error(`GitHub ${what}: ${r.status} ${String((r.data as { message?: string } | null)?.message ?? "")}`.trim()); }

  /** An installation access token for the repository, cached until five minutes before it expires. */
  async installationToken(): Promise<string> {
    if (this.cached && this.cached.expires - this.now() > 300) return this.cached.token;
    const jwt = `Bearer ${appJwt(this.o.appId, this.o.privateKey, this.now())}`;
    if (this.installation === undefined) {
      const r = await this.call("GET", `${this.api}/repos/${this.o.repo}/installation`, jwt);
      if (r.status !== 200) throw this.fail(`could not find the App's installation on ${this.o.repo} (is the App installed there?)`, r);
      this.installation = Number((r.data as { id: number }).id);
    }
    const r = await this.call("POST", `${this.api}/app/installations/${this.installation}/access_tokens`, jwt, { repositories: [this.o.repo.split("/")[1]] });
    if (r.status !== 201 && r.status !== 200) throw this.fail("refused an installation token", r);
    const d = r.data as { token: string; expires_at: string };
    this.cached = { token: d.token, expires: Math.floor(new Date(d.expires_at).getTime() / 1000) };
    return d.token;
  }
  private async asApp(): Promise<string> { return `Bearer ${await this.installationToken()}`; }

  async findPr(branch: string, state: "open" | "all" = "open"): Promise<PullRequest | null> {
    const owner = this.o.repo.split("/")[0];
    const r = await this.call("GET", `${this.api}/repos/${this.o.repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=${state}`, await this.asApp());
    if (r.status !== 200) throw this.fail("could not list pull requests", r);
    const first = (r.data as { number: number; html_url: string }[])[0];
    return first ? { number: first.number, url: first.html_url } : null;
  }
  async createPr(branch: string, base: string, title: string, body: string): Promise<PullRequest> {
    const r = await this.call("POST", `${this.api}/repos/${this.o.repo}/pulls`, await this.asApp(), { title, head: branch, base, body });
    if (r.status !== 201) throw this.fail("could not open the pull request", r);
    const d = r.data as { number: number; html_url: string }; return { number: d.number, url: d.html_url };
  }
  authorizeUrl(state: string, redirect: string): string { return `${this.web}/login/oauth/authorize?client_id=${encodeURIComponent(this.o.clientId)}&redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}`; }
  /** Exchange the OAuth code for the person's token, then read who they are. The token is used once and dropped. */
  async signIn(code: string, redirect: string): Promise<{ login: string; id: number; name: string }> {
    const t = await this.f(`${this.web}/login/oauth/access_token`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "litmustest" }, body: JSON.stringify({ client_id: this.o.clientId, client_secret: this.o.clientSecret, code, redirect_uri: redirect }) });
    const tok = (await t.json().catch(() => null)) as { access_token?: string; error_description?: string } | null;
    if (!tok?.access_token) throw new Error(`GitHub did not accept the sign-in code${tok?.error_description ? `: ${tok.error_description}` : ""}`);
    const u = await this.call("GET", `${this.api}/user`, `Bearer ${tok.access_token}`);
    if (u.status !== 200) throw this.fail("could not read the signed-in user", u);
    const d = u.data as { login: string; id: number; name?: string | null };
    return { login: d.login, id: d.id, name: d.name || d.login };
  }
  /** admin, maintain, write, triage, read or none: the person's permission on the repository, asked as the App. */
  async permission(login: string): Promise<string> {
    const r = await this.call("GET", `${this.api}/repos/${this.o.repo}/collaborators/${encodeURIComponent(login)}/permission`, await this.asApp());
    if (r.status === 404) return "none";
    if (r.status !== 200) throw this.fail(`could not read ${login}'s permission`, r);
    const d = r.data as { permission?: string; role_name?: string; user?: { permissions?: Record<string, boolean> } };
    const p = d.user?.permissions;
    if (p) return p.admin ? "admin" : p.maintain ? "maintain" : p.push ? "write" : p.triage ? "triage" : p.pull ? "read" : "none";
    return String(d.role_name ?? d.permission ?? "none");
  }
}

/** Git for the hosted clone: a commit is authored by the signed-in person, and a discard is a commit that restores the base. */
export class HostedGit extends Git {
  private h: { actor: () => Actor | undefined; mergeBase: () => string; committed: () => void };
  constructor(inside: string, h: { actor: () => Actor | undefined; mergeBase: () => string; committed: () => void }) { super(inside); this.h = h; }
  staged(): boolean { return this.run(["diff", "--cached", "--name-only"]).trim() !== ""; }
  override commit(rels: string[], message: string): string {
    this.run(["add", "-A", "--", ...rels]);
    return this.commitStaged(message);
  }
  private commitStaged(message: string): string {
    if (!this.staged()) return this.head(); // every save is already a commit; nothing is left to add
    const a = this.h.actor();
    const author = a ? `${a.name} <${a.email}>` : "litmustest <litmustest@users.noreply.github.com>";
    this.run([...BOT, "commit", "-q", "--author", author, "-m", message]);
    this.h.committed();
    return this.head();
  }
  /** Restore the paths to what the base branch has (or remove a file the branch added), as a new commit by the person. */
  override discard(rels: string[]): void {
    const base = this.h.mergeBase();
    for (const r of rels) {
      const inBase = (() => { try { this.run(["cat-file", "-e", `${base}:${r}`]); return true; } catch { return false; } })();
      if (inBase) this.run(["checkout", base, "--", r]); else this.run(["rm", "-qf", "--", r]);
    }
    this.commitStaged(`evals: discard ${rels.map((r) => r.replace(/^.*evals\//, "")).slice(0, 3).join(", ")}${rels.length > 3 ? ` and ${rels.length - 3} more` : ""}`);
  }
}

/** The tray in hosted mode: nothing waits uncommitted, so it lists what the pull-request branch changes against its base. */
export class HostedPending extends Pending {
  private h: Hosted;
  constructor(git: Git, evalsDir: string, h: Hosted) { super(git, evalsDir); this.h = h; }
  override track(): void { /* committed on write */ }
  override clear(): void { /* nothing local to forget */ }
  private changed(): { rel: string; status: PendingFile["status"] }[] {
    if (!this.git.branch().startsWith("evals/")) return [];
    const out: { rel: string; status: PendingFile["status"] }[] = [];
    for (const line of this.git.run(["diff", "--name-status", "--no-renames", this.h.mergeBase(), "HEAD", "--", this.git.rel(this.evalsDir)]).split("\n")) {
      const [code, rel] = line.split("\t"); if (!code || !rel) continue;
      out.push({ rel, status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified" });
    }
    return out;
  }
  override count(): number { return this.changed().length; }
  override state(): PendingState & { hosted: true; pr: PullRequest | null; base: string; commits: { sha: string; author: string; at: string; message: string }[] } {
    const branch = this.git.branch(); const base = this.h.mergeBase();
    const files: PendingFile[] = this.changed().map(({ rel, status }) => ({ path: rel, status, diff: this.git.run(["diff", base, "HEAD", "--", rel]), affected_views: VIEWS_FOR(rel), written_at: this.git.run(["log", "-1", "--format=%aI", "--", rel]).trim() }));
    const commits = branch.startsWith("evals/") ? this.git.run(["log", `${base}..HEAD`, "--format=%h%x09%an%x09%aI%x09%s"]).split("\n").filter(Boolean).map((l) => { const [sha, author, at, ...m] = l.split("\t"); return { sha: sha!, author: author!, at: at!, message: m.join("\t") }; }) : [];
    return { branch, files: files.sort((a, b) => a.path.localeCompare(b.path)), hosted: true, pr: this.h.pr, base: this.h.base, commits };
  }
}

export type Settled = { ok: true } | { conflict: string } | { error: string };

export class Hosted {
  readonly o: HostedOptions; readonly gh: GitHub; readonly workDir: string; readonly evalsDir: string;
  app!: App; git!: HostedGit; base = "main"; pr: PullRequest | null = null;
  private actors = new AsyncLocalStorage<Actor>();
  private token: string | undefined; private dirty = false;
  private queue: Promise<unknown> = Promise.resolve();
  private perms = new Map<string, { permission: string; at: number }>();
  private timers: NodeJS.Timeout[] = []; private later: NodeJS.Timeout | undefined;

  private constructor(o: HostedOptions) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(o.repo)) throw new Error(`--repo must be owner/name, got '${o.repo}'`);
    this.o = o; this.gh = new GitHub(o);
    this.workDir = resolve(o.workDir ?? join(homedir(), ".litmustest", "hosted", o.repo.replace("/", "__")));
    this.evalsDir = join(this.workDir, o.dir ?? "evals");
  }

  /** Clone (or fetch) the repository, open the App over it and catch up with GitHub. */
  static async start(o: HostedOptions): Promise<Hosted> {
    const h = new Hosted(o);
    await h.ensureToken();
    if (!existsSync(join(h.workDir, ".git"))) { mkdirSync(dirname(h.workDir), { recursive: true }); h.net(["clone", "-q", h.remote(), h.workDir], dirname(h.workDir)); }
    else h.net(["fetch", "-q", "--prune", "origin"]);
    const root = new Git(h.workDir);
    h.base = o.base ?? (() => { try { return root.run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim().replace(/^origin\//, ""); } catch { return "main"; } })();
    if (!existsSync(join(h.evalsDir, "litmustest.yaml"))) throw new Error(`${o.repo} has no ${o.dir ?? "evals"}/litmustest.yaml on ${root.branch()}; run litmustest init in the repository and merge it first`);
    h.app = new App(h.evalsDir, (dir) => h.backend(dir));
    await h.refresh();
    const every = o.pollSeconds ?? 60;
    if (every > 0) { const t = setInterval(() => void h.refresh().catch(() => {}), every * 1000); t.unref(); h.timers.push(t); }
    return h;
  }
  close(): void { for (const t of this.timers) clearInterval(t); clearTimeout(this.later); }

  private now(): number { return Math.floor((this.o.now?.() ?? Date.now()) / 1000); }
  private remote(): string { return this.o.remoteUrl ?? `${(this.o.githubUrl ?? "https://github.com").replace(/\/$/, "")}/${this.o.repo}.git`; }
  private async ensureToken(): Promise<void> { this.token = await this.gh.installationToken(); }
  /** A git command that talks to the remote. The installation token rides in the environment as a one-off http header:
   *  never in .git/config, never on a command line another process could read. */
  private net(args: string[], cwd = this.workDir): string {
    const auth: Record<string, string> = /^https?:/.test(this.remote()) && this.token ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.token}`).toString("base64")}` } : {};
    try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...auth } }); }
    catch (e) { throw new Error(`git ${args[0]}: ${String((e as { stderr?: string }).stderr ?? (e as Error).message).trim().split("\n").slice(-1)[0]}`); }
  }

  actor(): Actor | undefined { return this.actors.getStore(); }
  /** Run a request as the signed-in person: every commit made inside is theirs. */
  run<T>(actor: Actor, fn: () => T): T { return this.actors.run(actor, fn); }
  mergeBase(): string { try { return this.git.run(["merge-base", `origin/${this.base}`, "HEAD"]).trim(); } catch { return `origin/${this.base}`; } }

  private backend(dir: string): Backend {
    this.git = new HostedGit(dir, { actor: () => this.actor(), mergeBase: () => this.mergeBase(), committed: () => { this.dirty = true; this.flushSoon(); } });
    return {
      git: this.git, pending: new HostedPending(this.git, dir, this),
      identity: () => this.actor()?.login ?? "",
      onWrote: (rels) => this.wrote(rels),
      openPr: () => this.pr ? { status: 200, body: { url: this.pr.url, branch: this.git.branch(), number: this.pr.number } } : { status: 409, body: { error: "no_pr", message: "Nothing has been saved yet. The pull request opens with the first save." } },
    };
  }

  /** App.wrote in hosted mode: commit everything under evals/ on the pull-request branch as the signed-in person. */
  private wrote(rels: string[]): void {
    if (!this.git.branch().startsWith("evals/")) this.newBranch(defaultSlug(rels));
    const names = rels.map((r) => r.replace(/^.*evals\//, ""));
    this.git.commit([this.git.rel(this.evalsDir)], `evals: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`);
  }
  /** evals/<slug>, or evals/<slug>-2 when a branch of that name was used before. The uncommitted write comes along. */
  private newBranch(slug: string): void {
    const taken = (n: string) => [`refs/heads/${n}`, `refs/remotes/origin/${n}`].some((ref) => { try { this.git.run(["show-ref", "--verify", "--quiet", ref]); return true; } catch { return false; } });
    let name = `evals/${slug}`; for (let i = 2; taken(name); i++) name = `evals/${slug}-${i}`;
    this.git.run(["switch", "-q", "-c", name]); this.pr = null;
  }
  private flushSoon(): void { clearTimeout(this.later); this.later = setTimeout(() => void this.flush(), 1500); this.later.unref(); }

  /** Push what was committed and make sure the pull request exists. One at a time; never throws. */
  flush(): Promise<Settled> {
    const next = this.queue.then(() => this.push()).catch((e: Error): Settled => ({ error: e.message }));
    this.queue = next; return next;
  }
  private async push(): Promise<Settled> {
    if (!this.dirty) return { ok: true };
    clearTimeout(this.later);
    await this.ensureToken();
    const branch = this.git.branch(); const refspec = `HEAD:refs/heads/${branch}`;
    try { this.net(["push", "-q", "origin", refspec]); }
    catch (first) {
      // Someone else moved the branch on GitHub. Take theirs and replay ours on top; if the two touch the same lines, theirs wins.
      try { this.net(["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]); } catch { return { error: (first as Error).message }; }
      try { this.git.run([...BOT, "rebase", "-q", `origin/${branch}`]); }
      catch {
        try { this.git.run(["rebase", "--abort"]); } catch { /* nothing to abort */ }
        this.git.run(["reset", "-q", "--hard", `origin/${branch}`]);
        this.dirty = false; this.app.invalidate(); this.app.emit({ type: "changed", files: [], errors: 0, warnings: 0 });
        return { conflict: `Someone else changed the same lines on ${branch} while you were editing. Their version was kept and yours was not saved: reload and make the edit again.` };
      }
      this.app.invalidate();
      this.net(["push", "-q", "origin", refspec]);
    }
    this.git.run(["update-ref", `refs/remotes/origin/${branch}`, "HEAD"]);
    this.dirty = false;
    if (!this.pr) this.pr = (await this.gh.findPr(branch)) ?? (await this.gh.createPr(branch, this.base, `evals: ${branch.slice(6)}`, "Opened by litmustest in hosted mode. Every save in the dashboard is a commit on this branch, authored by the person who made it. Review the diff and merge it; nothing reaches the base branch until a person does."));
    return { ok: true };
  }
  /** After a write route answered: push, and turn a lost race into the 409 the client already knows how to show. */
  async settle(r: Reply): Promise<Reply> {
    const s = await this.flush();
    if ("conflict" in s) return { status: 409, body: { error: "conflict", message: s.conflict, resolve: ["reload"] } };
    if ("error" in s && r.status < 400) return { status: 502, body: { error: "push_failed", message: `Saved on the server but not pushed to GitHub: ${s.error}. It will be retried with the next save.` } };
    return r;
  }

  /** Catch up with GitHub: new commits on the base, other people's pushes to the branch, and a merged or closed pull request. */
  async refresh(): Promise<void> {
    await (this.queue = this.queue.then(async () => {
      await this.ensureToken();
      this.net(["fetch", "-q", "--prune", "origin"]);
      const branch = this.git.branch(); const has = (ref: string) => { try { this.git.run(["show-ref", "--verify", "--quiet", ref]); return true; } catch { return false; } };
      const before = this.git.head();
      if (!branch.startsWith("evals/")) { this.git.run(["reset", "-q", "--hard", `origin/${this.base}`]); }
      else if (!this.dirty) {
        const remote = has(`refs/remotes/origin/${branch}`);
        const open = remote ? await this.gh.findPr(branch) : null;
        if (open) { this.pr = open; try { this.git.run(["merge", "-q", "--ff-only", `origin/${branch}`]); } catch { this.dirty = true; } }
        else {
          const ahead = Number(this.git.run(["rev-list", "--count", `origin/${this.base}..HEAD`]).trim());
          const finished = ahead === 0 || (await this.gh.findPr(branch, "all")) !== null;
          // The pull request was merged or closed: go back to the base branch. Otherwise these are saves that never got
          // their pull request (a restart, or GitHub refusing): push them and open it.
          if (finished) { this.git.run(["switch", "-q", "-C", this.base, `origin/${this.base}`]); this.pr = null; } else this.dirty = true;
        }
      }
      if (this.git.head() !== before) { this.app.invalidate(); this.app.emit({ type: "changed", files: [], errors: 0, warnings: 0 }); }
    }).catch(() => {}));
    if (this.dirty) await this.flush();
  }

  // ---- sign-in and the gate in front of every request
  private publicUrl(req: IncomingMessage): string { return (this.o.publicUrl ?? `http://${req.headers.host ?? "localhost"}`).replace(/\/$/, ""); }
  private cookie(name: string, value: string, maxAge: number, req: IncomingMessage): string { return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.publicUrl(req).startsWith("https:") ? "; Secure" : ""}`; }
  private async permissionOf(login: string): Promise<string> {
    const c = this.perms.get(login); if (c && this.now() - c.at < 300) return c.permission;
    const permission = await this.gh.permission(login); this.perms.set(login, { permission, at: this.now() }); return permission;
  }
  /** Who is acting, set by the server so nobody labels or triages under another name. */
  identify(path: string, body: Record<string, unknown>): void {
    const a = this.actor(); if (!a) return;
    if (path === "/api/labels" || path.endsWith("/dispute")) body.annotator = a.login;
    if (path.endsWith("/triage") || path === "/api/compare/expected") body.by = a.login;
  }

  /** Runs before the routes. Answers sign-in pages and refusals itself and returns null; otherwise returns the signed-in person. */
  async gate(req: IncomingMessage, res: ServerResponse): Promise<Actor | null> {
    const url = new URL(req.url ?? "/", "http://localhost"); const path = url.pathname; const method = req.method ?? "GET";
    const json = (status: number, body: unknown, headers: Record<string, string | string[]> = {}) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(body)); return null; };
    const go = (to: string, setCookie: string[] = []) => { res.writeHead(302, { location: to, "cache-control": "no-store", ...(setCookie.length ? { "set-cookie": setCookie } : {}) }); res.end(); return null; };
    const jar = cookies(req); const secret = this.o.sessionSecret;
    if (path === "/healthz") return json(200, { ok: true, repo: this.o.repo, branch: this.git.branch() });
    if (path === "/auth/login") {
      const state = randomBytes(16).toString("hex");
      return go(this.gh.authorizeUrl(state, `${this.publicUrl(req)}/auth/callback`), [this.cookie("lt_state", seal({ state, exp: this.now() + 600 }, secret), 600, req)]);
    }
    if (path === "/auth/callback") {
      const sent = unseal<{ state: string; exp: number }>(jar.lt_state, secret, this.now());
      const code = url.searchParams.get("code");
      if (!sent || !code || sent.state !== url.searchParams.get("state")) return json(400, { error: "bad_state", message: "The sign-in did not start here or took too long. Start again at /auth/login." });
      try {
        const u = await this.gh.signIn(code, `${this.publicUrl(req)}/auth/callback`);
        const permission = await this.gh.permission(u.login); this.perms.set(u.login, { permission, at: this.now() });
        if (permission === "none") return json(403, { error: "no_access", message: `${u.login} has no access to ${this.o.repo}.` });
        const actor: Actor = { login: u.login, id: u.id, name: u.name, email: `${u.id}+${u.login}@users.noreply.github.com`, exp: this.now() + SESSION_SECONDS };
        return go("/", [this.cookie("lt_session", seal(actor, secret), SESSION_SECONDS, req), this.cookie("lt_state", "", 0, req)]);
      } catch (e) { return json(502, { error: "sign_in_failed", message: (e as Error).message }); }
    }
    if (path === "/auth/logout") return go("/", [this.cookie("lt_session", "", 0, req)]);
    const actor = unseal<Actor>(jar.lt_session, secret, this.now());
    if (path === "/auth/me") return actor ? json(200, { login: actor.login, name: actor.name, repo: this.o.repo }) : json(401, { error: "unauthenticated", message: "Not signed in.", login: "/auth/login" });
    if (!actor) return path.startsWith("/api/") ? json(401, { error: "unauthenticated", message: "Sign in with GitHub to use this server.", login: "/auth/login" }) : go("/auth/login");
    if (WRITE.has(method) && path.startsWith("/api/")) {
      // A cookie rides along with a cross-site form post; a write must come from this server's own pages.
      const origin = req.headers.origin;
      if (origin && origin !== this.publicUrl(req)) return json(403, { error: "cross_origin", message: "Writes are only accepted from this server's own pages." });
      if (!READ_POSTS.has(path)) {
        let permission: string;
        try { permission = await this.permissionOf(actor.login); } catch (e) { return json(502, { error: "permission_check_failed", message: (e as Error).message }); }
        if (!["admin", "maintain", "write"].includes(permission)) return json(403, { error: "read_only", message: `${actor.login} can read ${this.o.repo} but not write to it. Ask for write access to save changes.` });
      }
    }
    return actor;
  }
}

/** Hosted options from the environment (docs/HOSTED.md). Throws naming every variable that is missing. */
export function hostedFromEnv(repo: string, flags: { dir?: string; workDir?: string; base?: string }, env: Record<string, string | undefined> = process.env): HostedOptions {
  const need = ["LITMUSTEST_APP_ID", "LITMUSTEST_APP_PRIVATE_KEY", "LITMUSTEST_APP_CLIENT_ID", "LITMUSTEST_APP_CLIENT_SECRET", "LITMUSTEST_SESSION_SECRET"];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`hosted mode needs ${missing.join(", ")} in the environment; see docs/HOSTED.md`);
  if (env.LITMUSTEST_SESSION_SECRET!.length < 32) throw new Error("LITMUSTEST_SESSION_SECRET must be at least 32 characters; generate one with: openssl rand -hex 32");
  return {
    repo, dir: flags.dir, workDir: flags.workDir ?? env.LITMUSTEST_WORKDIR, base: flags.base,
    appId: env.LITMUSTEST_APP_ID!, privateKey: env.LITMUSTEST_APP_PRIVATE_KEY!, clientId: env.LITMUSTEST_APP_CLIENT_ID!, clientSecret: env.LITMUSTEST_APP_CLIENT_SECRET!, sessionSecret: env.LITMUSTEST_SESSION_SECRET!,
    publicUrl: env.LITMUSTEST_PUBLIC_URL, apiUrl: env.LITMUSTEST_GITHUB_API, githubUrl: env.LITMUSTEST_GITHUB_URL,
  };
}
