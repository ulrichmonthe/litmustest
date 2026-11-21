// litmustest dashboard entry. Vanilla ES modules, no build step: the router is router.js, each screen is screens/<name>.js, the explain panel is explainer.js.
import { errorState } from "./components.js";
import { loadGlossary, loadPrefs } from "./explainer.js";
import { $, h } from "./lib/dom.js";
import { state } from "./lib/state.js";
import { render } from "./router.js";
import { judgePage } from "./screens/judges.js";
import { refreshHealth } from "./shell.js";
import { openPalette } from "./palette.js";

window.addEventListener("hashchange", render);
const events = new EventSource("/api/events");
for (const t of ["saved", "label", "committed", "discarded", "changed"]) events.addEventListener(t, () => { refreshHealth().catch(() => {}); if (t !== "label" && ["pending", "overview"].includes(state.route[0])) render(); });
events.addEventListener("calibrate", (e) => { const ev = JSON.parse(e.data); if (state.route[0] !== "judges" || state.route[1] !== ev.judge) return; const p = $(".progress-inline"); if (ev.state === "running" && p) p.textContent = `Running ${ev.split}: ${ev.done}/${ev.total}`; if (ev.state === "done" || ev.state === "failed") { if (p) p.textContent = ev.state === "failed" ? ev.message : `${ev.split} done · TPR ${ev.tpr ?? "—"} / TNR ${ev.tnr ?? "—"}`; judgePage.hashes = null; render(); } });
refreshHealth().then(() => Promise.all([loadGlossary(), loadPrefs()])).then(render).catch((e) => { $("#page").replaceChildren(errorState("Cannot reach litmustest serve", `${e.message}. Start it again with litmustest serve, then try again.`)); });
// Lost connection (design/mockups/v2/ErrorStatesP): the live-updates stream drops when the server stops. Say so in the top
// bar, and refresh what the shell shows once the stream reconnects (EventSource retries on its own).
let lost = false;
events.addEventListener("error", () => { if (events.readyState === EventSource.OPEN) return; lost = true; const c = $("#conn"); c.hidden = false; c.textContent = "Lost connection to litmustest serve. Saves fail until it is back; nothing was lost. Retrying…"; });
events.addEventListener("open", () => { if (!lost) return; lost = false; $("#conn").hidden = true; refreshHealth().then(render).catch(() => {}); });
// ⌘K search: the sidebar button opens the same palette as the shortcut; Ctrl+K off a Mac.
$("#search-btn").addEventListener("click", (e) => openPalette(e.currentTarget));
if (!/Mac|iPhone|iPad/.test(navigator.platform)) $("#search-kbd").textContent = "Ctrl K";
