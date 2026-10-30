// litmustest serve: the local HTTP server over evals/, with a file watcher and server-sent events.
import { glossaryHereRoute, glossaryRoute } from "./server/glossary_route.ts";
import { coverageRoute } from "./server/coverage_route.ts";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { watch, type FSWatcher } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { App, HttpError, type Reply } from "./server/app.ts";
import { discoverRoute } from "./server/discover_route.ts";
import type { Ask } from "./discover.ts";
import type { JudgeAsk } from "./judge_run.ts";
import { checkDraft, judgeCalibrate, judgeDetail, judgeDraft, judgesList, trainExcerpts } from "./server/judges.ts";
import { dispute, explainRoute, setTriage, transcriptsIndex, trial } from "./server/transcripts.ts";

export interface ServeOptions { evalsDir: string; port?: number; host?: string; watch?: boolean; ask?: Ask; judgeAsk?: JudgeAsk; draftAsk?: Ask; explainAsk?: Ask }
export interface Running { server: Server; app: App; url: string; close: () => Promise<void> }

export async function serve(o: ServeOptions): Promise<Running> {
  const app = new App(o.evalsDir);
  let watcher: FSWatcher | undefined;
  if (o.watch !== false) {
    let timer: NodeJS.Timeout | undefined; const changed = new Set<string>();
    try {
      watcher = watch(app.evalsDir, { recursive: true }, (_ev, file) => {
        if (!file) return; const rel = String(file).split(sep).join("/");
        if (rel.startsWith(".") || rel.includes("/.")) return;
        changed.add(rel);
        clearTimeout(timer);
        timer = setTimeout(() => { app.invalidate(); const v = app.validate(); app.emit({ type: "changed", files: [...changed], errors: v.errors, warnings: v.warnings }); changed.clear(); }, 150);
      });
    } catch { /* recursive watch unsupported: validation still happens on every request */ }
  }
  const server = createServer((req, res) => void handle(app, req, res, o.ask, { judgeAsk: o.judgeAsk, draftAsk: o.draftAsk ?? o.ask, explainAsk: o.explainAsk }));
  await new Promise<void>((r) => server.listen(o.port ?? 4242, o.host ?? "127.0.0.1", r));
  const addr = server.address() as { address: string; port: number };
  const url = `http://${addr.address}:${addr.port}`;
  return { server, app, url, close: () => new Promise((r) => { watcher?.close(); server.close(() => r()); }) };
}

async function handle(app: App, req: IncomingMessage, res: ServerResponse, ask?: Ask, hooks: { judgeAsk?: JudgeAsk; draftAsk?: Ask; explainAsk?: Ask } = {}): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname; const q = (k: string) => url.searchParams.get(k) ?? undefined;
  const send = (r: Reply) => { res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store", ...(r.headers ?? {}) }); res.end(JSON.stringify(r.body)); };
  try {
    if (path === "/api/events" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`event: hello\ndata: ${JSON.stringify(app.health().body)}\n\n`);
      const off = app.subscribe((e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
      req.on("close", off); return;
    }
    const body = ["PUT", "POST"].includes(req.method ?? "") ? await readJson(req) : {};
    if (!path.startsWith("/api/") && req.method === "GET") return serveStatic(path, res);
    if (path === "/api/failure_modes" && req.method === "GET") return send(app.failureModes());
    if (path === "/api/modes" && req.method === "GET") return send(app.modes());
    if (path === "/api/overview" && req.method === "GET") return send(app.overview());
    if (path === "/api/coverage" && req.method === "GET") return send(coverageRoute(app));
    if (path === "/api/glossary" && req.method === "GET") return send(glossaryRoute(app));
    if (path === "/api/glossary/here" && req.method === "POST") return send(glossaryHereRoute(app, body));
    if (path === "/api/runs" && req.method === "GET") return send(app.runs());
    if (path === "/api/tasks" && req.method === "GET") return send(app.tasks());
    if (path === "/api/graduate" && req.method === "GET") return send(app.graduate());
    if (path === "/api/graduate" && req.method === "POST") return send(app.applyGraduate((body.tasks as string[]) ?? []));
    if (path === "/api/doctor" && req.method === "GET") return send(app.doctor());
    if (path === "/api/transcripts" && req.method === "GET") return send(transcriptsIndex(app, q("run")));
    let tm: RegExpExecArray | null;
    if ((tm = /^\/api\/transcripts\/([^/]+)\/([^/]+)\/(\d+)$/.exec(path)) && req.method === "GET") return send(trial(app, decodeURIComponent(tm[1]!), decodeURIComponent(tm[2]!), Number(tm[3])));
    if ((tm = /^\/api\/transcripts\/([^/]+)\/([^/]+)\/(\d+)\/triage$/.exec(path)) && req.method === "POST") return send(setTriage(app, decodeURIComponent(tm[1]!), decodeURIComponent(tm[2]!), Number(tm[3]), body));
    if ((tm = /^\/api\/transcripts\/([^/]+)\/([^/]+)\/(\d+)\/explain$/.exec(path)) && req.method === "POST") return send(await explainRoute(app, decodeURIComponent(tm[1]!), decodeURIComponent(tm[2]!), Number(tm[3]), hooks.explainAsk ?? ask));
    if ((tm = /^\/api\/transcripts\/([^/]+)\/([^/]+)\/(\d+)\/dispute$/.exec(path)) && req.method === "POST") return send(dispute(app, decodeURIComponent(tm[1]!), decodeURIComponent(tm[2]!), Number(tm[3]), body));
    if (path === "/api/compare" && req.method === "GET") return send(app.compare(need(q("a"), "a"), need(q("b"), "b")));
    if (path === "/api/discover" && req.method === "POST") return send(await discoverRoute(app, body, ask));
    if (path === "/api/judges" && req.method === "GET") return send(judgesList(app));
    let jm: RegExpExecArray | null;
    if ((jm = /^\/api\/judges\/([^/]+)$/.exec(path)) && req.method === "GET") return send(judgeDetail(app, decodeURIComponent(jm[1]!)));
    if ((jm = /^\/api\/judges\/([^/]+)\/train$/.exec(path)) && req.method === "GET") return send(trainExcerpts(app, decodeURIComponent(jm[1]!)));
    if ((jm = /^\/api\/judges\/([^/]+)\/calibrate$/.exec(path)) && req.method === "POST") return send(await judgeCalibrate(app, decodeURIComponent(jm[1]!), body, hooks));
    if ((jm = /^\/api\/judges\/([^/]+)\/draft$/.exec(path)) && req.method === "POST") return send(await judgeDraft(app, decodeURIComponent(jm[1]!), hooks));
    if ((jm = /^\/api\/checks\/([^/]+)\/draft$/.exec(path)) && req.method === "POST") return send(await checkDraft(app, decodeURIComponent(jm[1]!), hooks));
    if (path === "/api/health") return send(app.health());
    if (path === "/api/validate") return send({ status: 200, body: app.validate(Boolean(q("refresh"))) });
    if (path === "/api/files" && req.method === "GET") return send(app.listFiles());
    if (path === "/api/file" && req.method === "GET") return send(app.getFile(need(q("path"), "path")));
    if (path === "/api/file" && req.method === "PUT") return send(app.putFile(need(body.path as string, "path"), body.content as string | undefined, body.base_hash as string | undefined, body.data));
    if (path === "/api/labels" && req.method === "POST") { const { batch, ...label } = body; return send(app.appendLabel(need(batch as string, "batch"), label)); }
    if (path === "/api/pending" && req.method === "GET") return send(app.pendingState());
    if (path === "/api/pending/commit" && req.method === "POST") return send(app.commit(body.message as string | undefined, body.slug as string | undefined));
    if (path === "/api/pending/pr" && req.method === "POST") return send(app.openPr(body.title as string | undefined, body.body as string | undefined));
    if (path === "/api/pending/discard" && req.method === "POST") return send(app.discard(body.paths as string[] | undefined));
    if (path === "/api/batches" && req.method === "GET") return send(app.batches());
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/batches\/([^/]+)$/.exec(path)) && req.method === "GET") return send(app.batch(decodeURIComponent(m[1]!)));
    if ((m = /^\/api\/traces\/([^/]+)$/.exec(path)) && req.method === "GET") return send(app.trace(decodeURIComponent(m[1]!)));
    send({ status: 404, body: { error: "not_found", message: `${req.method} ${path}` } });
  } catch (e) {
    if (e instanceof HttpError) return send({ status: e.status, body: { error: "error", message: e.message } });
    send({ status: 500, body: { error: "internal", message: (e as Error).message } });
  }
}

function need<T>(v: T | undefined, name: string): T { if (v === undefined || v === null || v === "") throw new HttpError(400, `${name} is required`); return v; }
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new HttpError(400, `bad JSON body: ${(e as Error).message}`)); } }); req.on("error", reject); });
}
const UI_DIR = (() => { const here = dirname(fileURLToPath(import.meta.url)); for (const c of [join(here, "..", "ui"), join(here, "..", "..", "ui")]) if (existsSync(join(c, "index.html"))) return c; return join(here, "..", "ui"); })();
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
function serveStatic(path: string, res: ServerResponse): void {
  const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  const file = resolve(UI_DIR, rel);
  if (!file.startsWith(UI_DIR) || !existsSync(file) || extname(file) === "") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(readFileSync(join(UI_DIR, "index.html"))); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }); res.end(readFileSync(file));
}
