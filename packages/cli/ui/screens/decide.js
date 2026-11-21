// litmustest dashboard: screens/decide.js. Decide (design/mockups/v2/DecideP): one reply at a time, for tasks that broke
// only on a judge. A person says who is right; the answer is a label (through the same dispute route as a trial's
// "Dispute" link) or an expected flip, and lands in Pending changes. Labels are never written by Claude.
import { statusWord } from "../components.js";
import { term } from "../explainer.js";
import { $, api, h } from "../lib/dom.js";
import { stale, state } from "../lib/state.js";
import { refreshHealth } from "../shell.js";

export const decidePage = { done: new Set(), status: "" };
const enc = encodeURIComponent;

export async function renderDecide() {
  const seq = state.seq; const page = $("#page");
  const home = await api("/api/home"); if (stale(seq)) return;
  const items = home.decide.filter((x) => !decidePage.done.has(`${home.run?.run_id}/${x.task}`));
  const want = state.query.task;
  const i = Math.max(0, want ? items.findIndex((x) => x.task === want) : 0);
  const x = items[i];
  const back = h("a", { class: "btn quiet", href: "#/ship" }, "Back to Ship");
  if (!x) { page.replaceChildren(h("div", { class: "column decide" }, h("h1", { class: "home-heading" }, home.decide.length ? "Every reply is decided" : "Nothing to decide"), h("p", { class: "home-lead" }, home.decide.length ? "Your answers are in Pending changes. Commit them there; a stricter or kinder judge needs a re-check before it counts again." : "No task broke only on a judge in the latest run."), h("div", { class: "home-actions" }, h("a", { class: "btn primary", href: "#/pending" }, "Open Pending changes"), back))); return; }
  const run = home.run.run_id; const prev = home.previous?.run_id;
  const [t, modes] = await Promise.all([api(`/api/transcripts/${enc(run)}/${enc(x.task)}/${x.n}`).catch(() => null), api("/api/failure_modes")]); if (stale(seq)) return;
  const mode = modes.failure_modes.find((m) => m.name === x.failure_mode);
  const g = t?.grades?.find((y) => y.check === x.check);
  const turns = (t?.view?.turns ?? []).filter((y) => y.role === "user" || y.role === "agent");
  const status = h("p", { class: "status", "aria-live": "polite" }, decidePage.status);
  const annotator = state.health?.annotator || "dashboard";
  async function answer(kind) {
    status.className = "status"; status.textContent = "Saving…";
    try {
      if (kind === "intended") await api("/api/compare/expected", { method: "POST", body: JSON.stringify({ a: prev, b: run, task: x.task, expected: true, note: "Decided on Ship: the new behaviour is what we want", by: annotator }) });
      else await api(`/api/transcripts/${enc(run)}/${enc(x.task)}/${x.n}/dispute`, { method: "POST", body: JSON.stringify({ check: x.check, label: kind === "agent" ? "Fail" : kind === "judge" ? "Pass" : "Skip", annotator, note: kind === "agent" ? `Decided on Ship: the ${x.judge} judge was right on ${x.task} trial ${x.n} of ${run}` : kind === "judge" ? `Decided on Ship: the reply is fine; the ${x.judge} judge is too strict on ${x.task} trial ${x.n} of ${run}` : `Decided on Ship: could not tell on ${x.task} trial ${x.n} of ${run}` }) });
      decidePage.done.add(`${run}/${x.task}`); decidePage.status = "Saved. It is in Pending changes."; await refreshHealth();
      location.hash = "#/ship/decide";
    } catch (e) { status.className = "status bad"; status.textContent = `Not saved · ${e.body?.problems?.[0]?.message ?? e.message}`; }
  }
  const choice = (key, kind, title, sub) => h("button", { type: "button", class: "choice", onclick: () => answer(kind) }, h("span", { class: "choice-key", "aria-hidden": "true" }, key), h("span", { class: "choice-text" }, h("span", { class: "choice-title" }, title), h("span", { class: "choice-sub" }, sub)));
  const keys = (e) => { if (e.target.closest?.("input, textarea, select") || e.metaKey || e.ctrlKey) return; const k = { 1: "agent", 2: "judge", 3: "skip", 4: "intended" }[e.key]; if (k) { e.preventDefault(); answer(k); } else if (e.key === "Escape") location.hash = "#/ship"; };
  decidePage.keys = keys;
  page.replaceChildren(h("div", { class: "column decide" },
    h("div", { class: "decide-head" }, h("p", { class: "eyebrow-status" }, `${i + 1} of ${items.length}`, h("span", { "aria-hidden": "true" }, " · "), h("span", { class: "mono" }, x.task), ` · trial ${x.n} of ${run}`), back),
    h("h1", { class: "home-heading" }, `Is the ${x.judge} judge right about this reply?`),
    h("div", { class: "decide-body" },
      h("div", { class: "decide-convo", "aria-label": "Conversation" },
        ...(turns.length ? turns.map((y) => h("div", { class: `bubble ${y.role === "user" ? "customer" : "agent"}` }, h("span", { class: "eyebrow" }, y.role === "user" ? "Customer" : "Agent"), h("p", {}, String(y.content ?? "")))) : [h("p", { class: "muted" }, "This trial's transcript is not in the store.")])),
      h("div", { class: "decide-side" },
        h("div", { class: "decide-card" }, h("span", { class: "label" }, term("judge", `${x.judge} judge`)), g ? statusWord(g.pass === false ? "bad" : g.pass === true ? "good" : "warn", g.verdict ?? (g.pass ? "Pass" : "Fail")) : null, g?.critique ? h("p", {}, `“${g.critique}”`) : null),
        mode ? h("div", { class: "decide-card" }, h("span", { class: "label" }, "Your team's rule"), h("p", {}, mode.definition)) : null)),
    h("div", { class: "choices", role: "group", "aria-label": "Your call" },
      choice("1", "agent", "The judge is right.", "The agent needs a fix; the gate keeps blocking."),
      choice("2", "judge", "The reply is fine.", "The judge is too strict; your label goes into its next calibration."),
      choice("3", "skip", "Can't tell.", "Saved as Skip; it counts neither way."),
      prev ? choice("4", "intended", "It's an intended change.", `Marked expected against ${prev}; it explains the change, it does not waive a gate.`) : null),
    h("p", { class: "caption muted" }, "Your answer is saved as a label under ", h("span", { class: "mono" }, "labels/"), " (or on the run, for an intended change) and lands in Pending changes. Nothing reaches git until you commit."),
    status));
}
