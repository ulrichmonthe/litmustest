// litmustest dashboard: router.js
import { header, renderSoon } from "./components.js";
import { command, commands, fillPlain, gloss, hidePeek, syncPanel, wirePills } from "./explainer.js";
import { $, h } from "./lib/dom.js";
import { state } from "./lib/state.js";
import { renderCompare } from "./screens/compare.js";
import { renderCoverage } from "./screens/coverage.js";
import { renderDiscover } from "./screens/discover.js";
import { renderJudge, renderJudges } from "./screens/judges.js";
import { renderModes } from "./screens/modes.js";
import { renderOverview } from "./screens/overview.js";
import { renderPending } from "./screens/pending.js";
import { renderReview, review } from "./screens/review.js";
import { renderSettings } from "./screens/settings.js";
import { renderTasks } from "./screens/tasks.js";
import { renderTranscripts, renderTrial } from "./screens/transcripts.js";
import { renderNav } from "./shell.js";
import { OLD, hashOf, toPlace, toScreen } from "./routes.js";

// ---------------- router
export async function render() {
  const [pathPart, qs = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  // An old link (#/overview, #/judges/x, …) or no path at all goes to its place; replace keeps Back working.
  if (!parts.length || OLD.has(parts[0])) { location.replace(hashOf(parts.length ? toPlace(parts) : ["home"], qs)); return; }
  state.query = Object.fromEntries(new URLSearchParams(qs));
  state.path = parts;
  state.route = toScreen(parts) ?? parts;
  state.seq++;
  window.scrollTo(0, 0);
  gloss.seen.clear(); hidePeek(); commands.clear(); registerGlobalCommands();
  renderNav();
  document.removeEventListener("keydown", keyHandler); review.keys = null;
  try {
    switch (state.route[0]) {
      case "review": await renderReview(state.route[1], state.route[2]); document.addEventListener("keydown", keyHandler); break;
      case "pending": await renderPending(); break;
      case "discover": await renderDiscover(state.route[1]); break;
      case "modes": await renderModes(state.route[1]); break;
      case "overview": await renderOverview(); break;
      case "judges": if (state.route[1]) await renderJudge(state.route[1]); else await renderJudges(); break;
      case "coverage": await renderCoverage(state.route[1], state.route[2] ? decodeURIComponent(state.route[2]) : undefined); break;
      case "compare": await renderCompare(state.route[1], state.route[2]); break;
      case "tasks": await renderTasks(state.route[1], state.route[2]); break;
      case "settings": await renderSettings(); break;
      case "transcripts": if (state.route[3]) await renderTrial(state.route[1], state.route[2], Number(state.route[3])); else await renderTranscripts(state.route[1]); break;
      default: renderSoon("Not found");
    }
  } catch (e) { $("#page").replaceChildren(h("div", { class: "column" }, header("Something went wrong"), h("div", { class: "empty" }, e.message))); }
  wirePills(); fillPlain(state.seq); syncPanel();
}
/** Commands available on every screen. */
export function registerGlobalCommands() {
  command("review.openBatch", { label: () => "Open the review queue", run: () => { location.hash = `#/review/${encodeURIComponent(state.batches[0]?.name ?? "")}`; }, enabled: () => state.batches.length > 0, reason: () => "No review batch yet: run litmustest ingest." });
}
export function keyHandler(e) { if (e.metaKey && e.key !== "Enter") return; review.keys?.(e); }
