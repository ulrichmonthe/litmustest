import { discover, type Ask } from "../discover.ts";
import type { App } from "./app.ts";
import type { Reply } from "./app.ts";

/** POST /api/discover: propose failure-mode files from notes. Nothing is written; the client accepts via PUT /api/file. */
export async function discoverRoute(app: App, body: Record<string, unknown>, ask?: Ask): Promise<Reply> {
  try {
    const r = await discover({ evalsDir: app.evalsDir, batch: body.batch as string | undefined, ask });
    return { status: 200, body: r };
  } catch (e) {
    const msg = (e as Error).message;
    const auth = /authentication|api key|apiKey|authToken|401/i.test(msg);
    return { status: auth ? 502 : 400, body: { error: auth ? "model_unavailable" : "discover_failed", message: auth ? `cannot reach the model: ${msg}. Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment that runs litmustest serve.` : msg } };
  }
}
