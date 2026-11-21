// litmustest dashboard: screens/ship.js. Ship (design/mockups/v2/ShipP, ShipSafeP, RunPickerP): is this change safe to merge?
// Two runs compared on the same tasks: every suite's gate with its margin bar, the tasks that changed as trial dots,
// one selected task's checks, failure-mode deltas and cost. The numbers are compareRuns and evaluateGates, as in CI.
import { deltaText, dotsLabel, marginBar, roundCi, statusWord, trialDots } from "../components.js";
import { count, num, plain, rate, term } from "../explainer.js";
import { $, api, h } from "../lib/dom.js";
import { stale, state } from "../lib/state.js";
import { refreshHealth } from "../shell.js";

export const cmp = { filter: null, sel: null };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const enc = encodeURIComponent;
const trialHref = (run, task, n) => `#/library/runs/${enc(run)}/${enc(task)}/${n}`;
const firstFail = (dots) => { const i = (dots ?? []).findIndex((d) => d === "fail"); return (i < 0 ? 0 : i) + 1; };

function gateStatus(s) {
  const g = s.gate ?? {};
  if (g.report_only) return statusWord("none", "Report only");
  if (g.min_pass_rate === undefined && g.max_drop_pts === undefined) return statusWord("none", "No gate");
  if (s.gate_result?.passed) return statusWord("good", "Passes");
  return statusWord("bad", g.min_pass_rate !== undefined && s.b < g.min_pass_rate ? `Below ${g.min_pass_rate}%` : "Dropped too far");
}

function gatesTable(c, a, b) {
  const head = h("div", { class: "ship-grid ship-head", role: "row" }, ...["Suite", "Pass rate", "Range and gate", "Change", "Status"].map((t, i) => h("span", { role: "columnheader" }, i === 2 ? term("margin_bar", t) : i === 4 ? term("gate", t) : t)));
  const rows = c.suites.map((s) => {
    const ci = roundCi(s.b_ci); const min = s.gate?.min_pass_rate ?? null;
    const words = `${s.b}%${ci ? `, could be ${ci.low} to ${ci.high}%` : ""}${min !== null ? `, gate at ${min}%` : ", no gate"}`;
    return h("div", { class: "ship-grid ship-row", role: "row" },
      h("span", { class: "ship-suite", role: "cell" }, h("a", { href: `#/cover/tasks/${enc(s.name)}` }, cap(s.name)), h("span", { class: "muted" }, ` · ${s.n_tasks}`)),
      h("span", { class: "ship-rate", role: "cell" }, num("corrected_rate", "suite", { suite: s.name, run: b }, rate(s.b, ci))),
      h("span", { role: "cell" }, marginBar({ rate: s.b, ci, min, label: `${cap(s.name)}: ${words}` })),
      h("span", { class: `ship-change${s.significant && s.delta < 0 ? " bad" : ""}`, role: "cell" }, num("confidence_interval", "delta", { a, b, suite: s.name }, `${deltaText({ pts: s.delta, ci: s.ci })} · ${s.significant ? "real" : "noise"}`)),
      h("span", { role: "cell" }, num("gate", "delta", { a, b, suite: s.name }, gateStatus(s))));
  });
  return h("section", { class: "ship-gates", "aria-label": "Gates", role: "table" }, head, ...rows,
    h("p", { class: "caption muted" }, "The bar: the likely range in blue, the measured rate as the tick, the gate as the dashed line."),
    ...c.suites.map((s) => plain("gate", "delta", { a, b, suite: s.name })));
}

function changes(c, a, b, rerender, onSelect) {
  const n = (k) => c.flips.filter((f) => f.change === k).length;
  const filter = cmp.filter ?? (n("Broke") ? "Broke" : "All");
  const list = c.flips.filter((f) => filter === "All" || f.change === filter);
  const seg = (k, label) => h("button", { type: "button", "aria-pressed": filter === k ? "true" : "false", onclick: () => { cmp.filter = k; cmp.sel = null; rerender(); } }, `${label} ${k === "All" ? c.flips.length : n(k)}`);
  const sel = list.find((f) => f.task === cmp.sel) ?? list[0] ?? null;
  const row = (f) => h("button", { type: "button", class: "change-row", "aria-pressed": f === sel ? "true" : "false", onclick: () => { cmp.sel = f.task; onSelect(); } },
    h("span", { class: "change-task" }, h("span", { class: "mono" }, f.task), h("span", { class: "muted" }, cap(f.suite)), f.expected ? h("span", { class: "pill" }, "Expected") : null),
    trialDots(f.dots_a, dotsLabel("Before", f.dots_a)), trialDots(f.dots_b, dotsLabel("After", f.dots_b)),
    h("span", { class: "mono muted" }, f.check ?? ""));
  return { sel, el: h("div", { class: "changes" },
    h("div", { class: "section-head" }, h("h2", {}, "What changed"), h("div", { class: "seg", role: "group", "aria-label": "Show" }, seg("Broke", "Broke"), seg("Fixed", "Fixed"), seg("Flaky", "Flaky"), seg("All", "All"))),
    list.length ? h("div", { class: "change-list" }, h("div", { class: "change-row change-head", "aria-hidden": "true" }, h("span", {}, term("flip", "Task")), h("span", {}, a), h("span", {}, b), h("span", {}, "Failing check")), ...list.map(row))
      : h("p", { class: "empty-quiet" }, filter === "Broke" ? "No task went from passing to failing." : "No task in this group."),
    list.length ? h("p", { class: "caption muted" }, "Each dot is one trial: filled green passed, filled red failed, a hollow ring was an infrastructure error and is not counted.") : null,
    c.flips.some((f) => f.expected) ? h("p", { class: "caption muted" }, term("expected_flip", "Expected"), " changes are left out of the sentence at the top. They do not change a gate: the pass rates still decide that.") : null) };
}

async function selected(f, a, b, decideTasks, status, rerender) {
  const box = h("aside", { class: "ship-aside", "aria-label": "Selected task" }, h("p", { class: "muted" }, "Loading the trial…"));
  if (!f) { box.replaceChildren(h("p", { class: "muted" }, "Pick a task to see its checks.")); return box; }
  const n = firstFail(f.dots_b);
  (async () => {
    let t = null; try { t = await api(`/api/transcripts/${enc(b)}/${enc(f.task)}/${n}`); } catch { /* the transcript may not be stored */ }
    const failedJudge = t?.grades?.find((g) => g.type === "judge" && g.pass === false);
    async function markExpected() {
      let note;
      if (!f.expected) { note = prompt(`Why is it expected that ${f.task} ${f.change === "Fixed" ? "was fixed" : f.change === "Broke" ? "broke" : "became flaky"}? (optional)`, ""); if (note === null) return; }
      try { await api("/api/compare/expected", { method: "POST", body: JSON.stringify({ a, b, task: f.task, expected: !f.expected, note: note || undefined, by: state.health?.annotator || undefined }) }); await refreshHealth(); rerender(); }
      catch (e) { status.textContent = `Not saved · ${e.body?.problems?.[0]?.message ?? e.message}`; status.className = "status bad"; }
    }
    box.replaceChildren(
      h("div", { class: "aside-head" }, h("span", { class: "aside-title mono" }, f.task), h("span", { class: "muted" }, `${cap(f.suite)} · trial ${n} of ${(f.dots_b ?? []).length}`)),
      t?.grades?.length ? h("ul", { class: "check-list" }, ...t.grades.map((g) => h("li", {}, h("span", { class: "mono" }, g.check), g.excluded ? statusWord("none", "Excluded") : g.pass === true ? statusWord("good", "Pass") : g.pass === false ? statusWord("bad", "Fail") : statusWord("warn", "Unknown"))))
        : h("p", { class: "muted" }, "This trial's transcript is not in the store, so its checks cannot be shown."),
      failedJudge?.critique ? h("blockquote", { class: "critique-box" }, `“${failedJudge.critique}”`) : null,
      h("div", { class: "aside-actions" },
        decideTasks.has(f.task) ? h("a", { class: "btn primary", href: `#/ship/decide?task=${enc(f.task)}` }, "Decide who's right") : null,
        h("a", { class: "btn quiet", href: trialHref(b, f.task, n) }, "Open trial"),
        h("button", { type: "button", class: "btn quiet", onclick: markExpected }, f.expected ? "Unmark intended change" : "Mark as intended change")));
  })();
  return box;
}

function modesTable(c, b) {
  return h("section", { class: "ship-modes", "aria-label": "Failure-mode deltas" },
    h("div", { class: "section-head" }, h("h2", {}, term("failure_mode", "Failure modes")), h("span", { class: "caption muted" }, "Failed checks across every trial")),
    c.modes.length ? h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Failure mode"), h("th", { scope: "col", class: "num" }, "Before"), h("th", { scope: "col", class: "num" }, "After"), h("th", { scope: "col", class: "num" }, "Change"))),
      h("tbody", {}, ...c.modes.map((m) => h("tr", {}, h("td", {}, h("a", { class: "mono", href: `#/teach/modes/${enc(m.name)}` }, m.name)), h("td", { class: "num" }, String(m.a)), h("td", { class: "num" }, count(m.b, `#/library/runs/${enc(b)}?mode=${enc(m.name)}`)), h("td", { class: `num ${m.delta > 0 ? "bad" : m.delta < 0 ? "good" : "muted"}` }, m.delta > 0 ? `+${m.delta}` : m.delta < 0 ? `−${Math.abs(m.delta)}` : "0")))))
      : h("p", { class: "empty-quiet" }, "No check tied to a failure mode failed in either run."));
}

export async function renderCompare(aId, bId) {
  const seq = state.seq; const page = $("#page");
  const { runs } = await api("/api/runs"); if (stale(seq)) return;
  if (runs.length < 2) { page.replaceChildren(h("div", { class: "column ship" }, h("h1", { class: "home-heading" }, "Ship needs two runs"), h("p", { class: "empty" }, runs.length ? "Only one run is under evals/runs/. Run the suites again after a change, then compare the two here." : "No runs yet. Run the suites with litmustest run."))); return; }
  const b = bId ?? runs[0].run_id, a = aId ?? (runs.find((r) => r.run_id !== b)?.run_id ?? runs[1].run_id);
  const c = await api(`/api/compare?a=${enc(a)}&b=${enc(b)}`); if (stale(seq)) return;
  const home = state.homeData; const decideTasks = new Set(b === runs[0].run_id ? (home?.decide ?? []).map((x) => x.task) : []);
  const rerender = () => renderCompare(a, b);
  const status = h("span", { class: "status", "aria-live": "polite" });
  const go = (na, nb) => { cmp.sel = null; location.hash = `#/ship/${enc(na)}/${enc(nb)}`; };
  const pick = (label, val, other, onchange) => h("label", { class: "run-pick" }, h("span", { class: "sr-only" }, label), h("select", { class: "select mono", onchange: (e) => onchange(e.target.value) }, ...runs.map((r) => h("option", { value: r.run_id, selected: r.run_id === val, disabled: r.run_id === other }, `${r.run_id} · ${r.branch ?? ""}`))));
  const gated = c.suites.filter((s) => !s.gate?.report_only && (s.gate?.min_pass_rate !== undefined || s.gate?.max_drop_pts !== undefined));
  const failing = gated.filter((s) => !s.gate_result?.passed);
  async function postToPr(btn) {
    btn.disabled = true; status.className = "status"; status.textContent = "Posting…";
    try { const r = await api("/api/compare/comment", { method: "POST", body: JSON.stringify({ a, b }) }); status.textContent = `Posted on pull request ${r.pr}.`; status.className = "status good"; }
    catch (e) { status.textContent = e.message; status.className = "status bad"; }
    btn.disabled = false;
  }
  const ch = changes(c, a, b, rerender, () => rerender());
  page.replaceChildren(h("div", { class: "column ship" },
    h("div", { class: "ship-toolbar" },
      h("nav", { class: "tabs", "aria-label": "Ship sections" }, h("a", { href: `#/ship/${enc(a)}/${enc(b)}`, "aria-current": "page" }, "What changed"), h("a", { href: `#/library/runs/${enc(b)}` }, "All trials")),
      h("div", { class: "run-picker" }, pick("Candidate run", b, a, (v) => go(a, v)), h("span", { class: "muted" }, "vs"), pick("Baseline run", a, b, (v) => go(v, b)))),
    h("div", { class: "ship-title" },
      h("p", { class: "eyebrow-status" }, failing.length ? statusWord("bad", "Hold") : statusWord("good", "Safe to merge"), h("span", { "aria-hidden": "true" }, " · "), `${c.common_tasks} tasks × ${c.b.trials} trials, the same tasks on both versions`),
      h("h1", { class: "home-heading" }, failing.length ? `Not ready to ship: ${failing.length} of ${gated.length} ${gated.length === 1 ? "gate fails" : "gates fail"}` : "Ready to ship: every gate passes"),
      h("div", { class: "ship-actions" },
        h("button", { type: "button", class: "btn", onclick: (e) => postToPr(e.currentTarget) }, "Post to PR"),
        h("button", { type: "button", class: "btn quiet", onclick: async () => { try { await navigator.clipboard.writeText(c.markdown); status.textContent = "Copied the markdown for a PR comment."; status.className = "status good"; } catch { status.textContent = "Could not copy; the comment is in litmustest compare --format markdown."; status.className = "status bad"; } } }, "Copy as PR comment"),
        status)),
    gatesTable(c, a, b),
    h("div", { class: "ship-changes" }, ch.el, await selected(ch.sel, a, b, decideTasks, status, rerender)),
    modesTable(c, b),
    h("p", { class: "ship-cost" },
      h("span", {}, "Cost ", h("b", {}, `$${c.cost.a} → $${c.cost.b}`)),
      h("span", {}, "Tokens ", h("b", {}, `${c.cost.tokens_a.toLocaleString()} → ${c.cost.tokens_b.toLocaleString()}`)),
      h("span", {}, "Latency ", h("b", {}, `${(c.cost.latency_a / 1000).toFixed(1)} → ${(c.cost.latency_b / 1000).toFixed(1)} s`)),
      h("span", {}, term("infra_error", "Infra errors"), " ", h("b", {}, `${c.cost.infra_a}% → ${c.cost.infra_b}%`), " of trials, not counted"))));
}
