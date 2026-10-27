// litmustest serve: the local HTTP server over evals/, with a file watcher and server-sent events.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { watch, type FSWatcher } from "node:fs";
import { relative, sep } from "node:path";
import { App, HttpError, type Reply } from "./server/app.ts";

export interface ServeOptions { evalsDir: string; port?: number; host?: string; watch?: boolean }
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
  const server = createServer((req, res) => void handle(app, req, res));
  await new Promise<void>((r) => server.listen(o.port ?? 4242, o.host ?? "127.0.0.1", r));
  const addr = server.address() as { address: string; port: number };
  const url = `http://${addr.address}:${addr.port}`;
  return { server, app, url, close: () => new Promise((r) => { watcher?.close(); server.close(() => r()); }) };
}

async function handle(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    if (path === "/" && req.method === "GET") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(INDEX(app)); return; }
    if (path === "/api/health") return send(app.health());
    if (path === "/api/validate") return send({ status: 200, body: app.validate(Boolean(q("refresh"))) });
    if (path === "/api/files" && req.method === "GET") return send(app.listFiles());
    if (path === "/api/file" && req.method === "GET") return send(app.getFile(need(q("path"), "path")));
    if (path === "/api/file" && req.method === "PUT") return send(app.putFile(need(body.path as string, "path"), need(body.content as string, "content"), body.base_hash as string | undefined));
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
const INDEX = (app: App) => { const h = app.health().body as Record<string, unknown>; return `<!doctype html><meta charset="utf-8"><title>litmustest</title><body style="font:14px/1.5 system-ui;max-width:720px;margin:40px auto;color:#1c1917"><h1 style="font-size:20px">litmustest server</h1><p>Serving <code>${relative(String(h.repo), String(h.evals))}</code> on branch <code>${h.branch}</code>. ${h.errors} errors, ${h.warnings} warnings, ${h.pending} pending changes.</p><p>The dashboard arrives with the next phase. API: <code>/api/health</code>, <code>/api/files</code>, <code>/api/file?path=</code> (GET, PUT), <code>/api/labels</code> (POST), <code>/api/pending</code> (+ <code>/commit</code>, <code>/pr</code>, <code>/discard</code>), <code>/api/batches</code>, <code>/api/traces/:id</code>, <code>/api/validate</code>, <code>/api/events</code> (SSE).</p></body>`; };
