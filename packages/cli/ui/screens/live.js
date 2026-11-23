// litmustest dashboard: screens/live.js. A run started from the dashboard (docs/stories/redesign.md, N1;
// design/mockups/v2/RunningP, RunStoppedP): progress as trials finish, the budget, a cancel, and what to do when the run
// ends, stops at its budget, is cancelled or fails. The run itself is the same runner as `litmustest run`.
import { statusWord, trialDots } from "../components.js";
import { term } from "../explainer.js";
import { $, api, h } from "../lib/dom.js";
import { stale, state } from "../lib/state.js";
import { refreshHealth } from "../shell.js";

const enc = encodeURIComponent;
const money = (n) => `$${Number(n ?? 0).toFixed(2)}`;
const LEVEL = { running: ["warn", "Running"], done: ["good", "Finished"], budget: ["warn", "Stopped at budget"], cancelled: ["none", "Cancelled"], failed: ["bad", "Failed"] };

/** Keep a run's state, but never let an older snapshot replace a newer one: a reply to Start or Cancel can arrive after
 *  the live events that overtook it (a cancel or a short run can finish before its own reply comes back). */
export function keepJob(job) {
  const cur = state.runJob;
  if (cur && job && cur.run_id === job.run_id && ((cur.state !== "running" && job.state === "running") || (cur.state === job.state && cur.done > job.done))) return;
  state.runJob = job;
}

/** Start a run and follow it. `body` is { suites?, tasks?, trials? }; errors come back as a sentence. */
export async function startRun(body) {
  const r = await api("/api/runs/start", { method: "POST", body: JSON.stringify(body) });
  keepJob(r.job); location.hash = "#/library/runs/live";
}

/** The Run button for a page's header: the suites, or one task. */
export function runButton(body, label, status, cls = "btn primary") {
  if (state.runJob?.state === "running") return h("a", { class: cls, href: "#/library/runs/live" }, `Follow ${state.runJob.run_id}`);
  return h("button", { type: "button", class: cls, disabled: state.runJob?.state === "running", title: state.runJob?.state === "running" ? "A run is already going: follow it from Runs and trials" : "", onclick: async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try { await startRun(body); } catch (err) { btn.disabled = false; if (status) { status.className = "status bad"; status.textContent = `Not started · ${err.body?.message ?? err.message}`; } }
  } }, label);
}

function headline(j) {
  const tasks = j.tasks.length; const k = j.tasks[0]?.dots.length ?? 0; const even = j.tasks.every((t) => t.dots.length === k);
  const shape = `${tasks} ${tasks === 1 ? "task" : "tasks"}${even ? ` × ${k} ${k === 1 ? "trial" : "trials"}` : `, ${j.total} trials`}`;
  return { running: j.cancelling ? "Cancelling: stopping the trials that are running" : `Running ${shape}`, done: `Finished ${shape}`, budget: `Run stopped: the ${money(j.budget_usd)} budget ran out`, cancelled: "Run cancelled; nothing was saved", failed: "The run could not finish" }[j.state];
}

export async function renderLiveRun() {
  const seq = state.seq; const page = $("#page");
  if (!state.runJob) { const r = await api("/api/runs/active"); if (stale(seq)) return; state.runJob = r.job; }
  const j = state.runJob;
  if (!j) { page.replaceChildren(h("div", { class: "column" }, h("h1", { class: "teach-title" }, "No run in progress"), h("p", { class: "home-lead" }, "Start one from ", h("a", { href: "#/library/runs" }, "Runs and trials"), ", or with ", h("span", { class: "mono" }, "litmustest run"), " in a terminal."))); return; }
  const status = h("p", { class: "status", "aria-live": "polite" });
  const [lv, word] = LEVEL[j.state];
  const pct = j.total ? Math.round((100 * j.done) / j.total) : 0;
  const budgetPct = j.budget_usd ? Math.min(100, Math.round((100 * j.spent_usd) / j.budget_usd)) : 0;
  const cancel = async (btn) => { btn.disabled = true; try { const r = await api("/api/runs/active/cancel", { method: "POST", body: "{}" }); keepJob(r.job); renderLiveRun(); } catch (e) { btn.disabled = false; status.className = "status bad"; status.textContent = e.body?.message ?? e.message; } };
  const again = () => startRun({ suites: j.scope.suites, tasks: j.scope.tasks, trials: j.scope.trials ?? undefined }).catch((e) => { status.className = "status bad"; status.textContent = `Not started · ${e.body?.message ?? e.message}`; });
  const actions = j.state === "running" ? [h("button", { type: "button", class: "btn", disabled: j.cancelling, onclick: (e) => cancel(e.currentTarget) }, j.cancelling ? "Cancelling…" : "Cancel run")]
    : j.state === "done" ? [h("a", { class: "btn primary", href: "#/ship" }, "See what changed"), h("a", { class: "btn quiet", href: `#/library/runs/${enc(j.run_id)}` }, "Every trial")]
    : j.state === "budget" ? [h("a", { class: "btn primary", href: `#/library/runs/${enc(j.run_id)}` }, "See the partial results"), h("a", { class: "btn quiet", href: "#/library/settings" }, "Raise the budget in Settings")]
    : [h("button", { type: "button", class: "btn primary", onclick: again }, "Start again"), h("a", { class: "btn quiet", href: "#/library/runs" }, "Back to runs")];
  const note = j.state === "running" ? "Each trial runs your agent once and is graded when it finishes. You can leave this page; the run keeps going while litmustest serve is open."
    : j.state === "done" ? ["The summary is in ", h("span", { class: "mono" }, `evals/runs/${j.run_id}.json`), " and in Pending changes; commit it to keep it."]
    : j.state === "budget" ? `${j.done} of ${j.total} trials finished before the budget ran out. The results are partial: the summary marks the trials that never ran, and a gate on a partial run is not a fair comparison.`
    : j.state === "cancelled" ? `${j.done} of ${j.total} trials had finished. Nothing was written to evals/runs/, and the partial transcripts were removed.`
    : j.error ?? "The runner stopped with an error.";
  page.replaceChildren(h("div", { class: "column live-run" },
    h("header", { class: "teach-head" }, h("div", { class: "titles" },
      h("p", { class: "eyebrow-status" }, statusWord(lv, word), h("span", { "aria-hidden": "true" }, " · "), h("span", { class: "mono" }, j.run_id)),
      h("h1", { class: "teach-title" }, headline(j)), h("p", { class: "subtitle" }, ...[note].flat())),
      h("div", { class: "teach-actions" }, ...actions)),
    h("section", { class: "live-stats", "aria-label": "Progress" },
      h("div", { class: "live-stat" }, h("span", { class: "label" }, term("trial", "Trials")), h("span", { class: "live-n" }, `${j.done} of ${j.total}`),
        h("div", { class: "progress-track", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": j.total, "aria-valuenow": j.done, "aria-label": "Trials finished" }, h("span", { style: `width:${pct}%` })),
        h("span", { class: "caption muted" }, j.infra ? [`${j.infra} `, term("infra_error", j.infra === 1 ? "infra error" : "infra errors"), ", not counted"] : "No infra errors")),
      h("div", { class: "live-stat" }, h("span", { class: "label" }, "Budget"), h("span", { class: "live-n" }, j.budget_usd ? `${money(j.spent_usd)} of ${money(j.budget_usd)}` : money(j.spent_usd)),
        j.budget_usd ? h("div", { class: "progress-track", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": budgetPct, "aria-label": "Budget spent" }, h("span", { style: `width:${budgetPct}%` })) : null,
        h("span", { class: "caption muted" }, j.budget_usd ? ["Set in ", h("a", { href: "#/library/settings" }, "Settings"), " · runs and budget"] : ["No budget set; ", h("a", { href: "#/library/settings" }, "set one in Settings")]))),
    h("section", { class: "judges-list", "aria-label": "Tasks" }, h("table", { class: "plain" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Task"), h("th", { scope: "col" }, "Suite"), h("th", { scope: "col" }, "Trials"))),
      h("tbody", {}, ...j.tasks.map((t) => h("tr", {}, h("td", { class: "mono" }, t.id), h("td", { class: "muted" }, t.suite),
        h("td", {}, trialDots(t.dots.map((d) => d ?? "pending"), `${t.dots.filter((d) => d === "pass").length} passed, ${t.dots.filter((d) => d === "fail").length} failed, ${t.dots.filter((d) => d === null).length} to go`))))))),
    j.warnings.length && j.state !== "running" ? h("ul", { class: "caption muted live-warnings" }, ...j.warnings.map((w) => h("li", {}, w))) : null,
    status));
}

/** Called for every "run" event: keep the job, and redraw the live screen if it is open. */
export function onRunEvent(job) {
  const was = state.runJob?.state; keepJob(job);
  if (state.path?.[0] === "library" && state.path?.[2] === "live") renderLiveRun();
  if (was === "running" && job.state !== "running") refreshHealth().catch(() => {});
}
