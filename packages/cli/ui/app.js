// litmustest dashboard entry. Vanilla ES modules, no build step: the router is router.js, each screen is screens/<name>.js, the explain panel is explainer.js.
import { header } from "./components.js";
import { loadGlossary, loadPrefs } from "./explainer.js";
import { $, h } from "./lib/dom.js";
import { state } from "./lib/state.js";
import { render } from "./router.js";
import { judgePage } from "./screens/judges.js";
import { refreshHealth } from "./shell.js";

window.addEventListener("hashchange", render);
const events = new EventSource("/api/events");
for (const t of ["saved", "label", "committed", "discarded", "changed"]) events.addEventListener(t, () => { refreshHealth().catch(() => {}); if (t !== "label" && ["pending", "overview"].includes(state.route[0])) render(); });
events.addEventListener("calibrate", (e) => { const ev = JSON.parse(e.data); if (state.route[0] !== "judges" || state.route[1] !== ev.judge) return; const p = $(".progress-inline"); if (ev.state === "running" && p) p.textContent = `Running ${ev.split}: ${ev.done}/${ev.total}`; if (ev.state === "done" || ev.state === "failed") { if (p) p.textContent = ev.state === "failed" ? ev.message : `${ev.split} done · TPR ${ev.tpr ?? "—"} / TNR ${ev.tnr ?? "—"}`; judgePage.hashes = null; render(); } });
refreshHealth().then(() => Promise.all([loadGlossary(), loadPrefs()])).then(render).catch((e) => { $("#page").replaceChildren(h("div", { class: "column" }, header("Cannot reach the server"), h("div", { class: "empty" }, e.message))); });
