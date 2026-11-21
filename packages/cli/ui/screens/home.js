// litmustest dashboard: screens/home.js. Home (design/mockups/v2/HomeP, HomeSafeP, HomeNoKeyP, FirstRunP):
// the verdict as a sentence built from the files, every suite's gate as a margin bar, and Up next, ranked by /api/home.
// No model writes anything here; Claude's briefing is explainer layer 3 and waits for its own judge (docs/EXPLAINER.md).
import { marginBar, roundCi, signed, statusDot, statusWord } from "../components.js";
import { num, plain, rate, term } from "../explainer.js";
import { $, api, h } from "../lib/dom.js";
import { stale, state } from "../lib/state.js";

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const LEVEL = { hold: ["bad", "Hold"], safe: ["good", "Safe to merge"], no_runs: ["none", "No runs yet"] };

function gateRow(g) {
  const ci = roundCi(g.ci);
  const words = g.rate === null ? "no result yet" : `${g.rate}%${ci ? `, could be ${ci.low} to ${ci.high}%` : ""}${g.min !== null ? `, gate at ${g.min}%` : ", no gate"}`;
  const note = g.report_only ? [term("report_only", "Report only"), g.delta ? ` · ${signed(g.delta.pts)} pts, ` : "", g.delta ? term("confidence_interval", g.delta.significant ? "real" : "within noise") : ""]
    : g.min === null ? ["No minimum"]
    : [num("gate", "suite", { suite: g.suite }, h("span", { class: g.passed ? "good" : "bad" }, `${g.rate !== null && g.rate >= g.min ? "Above" : "Below"} the ${g.min}% gate`)), g.delta && g.delta.significant ? ` · ${g.delta.pts < 0 ? "down" : "up"} ${Math.abs(g.delta.pts)} pts` : ""];
  return h("div", { class: "gate-line" },
    h("div", { class: "gate-head" }, h("a", { class: "gate-name", href: `#/cover/tasks/${encodeURIComponent(g.suite)}` }, cap(g.suite)),
      h("span", { class: "gate-value" }, num("corrected_rate", "suite", { suite: g.suite }, rate(g.rate, ci)))),
    marginBar({ rate: g.rate, ci, min: g.min, label: `${cap(g.suite)}: ${words}` }),
    h("span", { class: "gate-note" }, ...note),
    plain("gate", "suite", { suite: g.suite }));
}

function upRow(u) {
  const level = u.level === "todo" ? "none" : u.level;
  return h("a", { class: "up-row", href: u.href },
    statusDot(level),
    h("span", { class: "up-text" }, h("span", { class: "up-title" }, u.title), h("span", { class: "up-reason" }, u.reason)),
    h("span", { class: "up-place" }, u.place),
    h("span", { class: "up-action" }, u.action));
}

function verdict(d) {
  const failing = d.gates.filter((g) => g.gated && g.rate !== null && !g.passed);
  const gated = d.gates.filter((g) => g.gated);
  const facts = [];
  for (const g of failing) { const ci = roundCi(g.ci); facts.push(`${cap(g.suite)} is at ${g.rate}%${ci ? ` (could be ${ci.low}–${ci.high}%)` : ""}${g.below_min ? ` and needs ${g.min}%` : `, a drop of more than the ${g.max_drop} points allowed`}.`); }
  if (d.counts && d.previous) facts.push(`Against ${d.previous.run_id}, ${d.counts.broke} ${d.counts.broke === 1 ? "task" : "tasks"} broke and ${d.counts.fixed} ${d.counts.fixed === 1 ? "was" : "were"} fixed.`);
  if (d.decide.length) { const judges = [...new Set(d.decide.map((x) => x.judge))]; facts.push(`${d.decide.length} of the breaks fail only on the ${judges.join(" and ")} ${judges.length > 1 ? "judges" : "judge"}: either the agent got worse, or the judge is stricter than you are.`); }
  if (d.state === "safe" && !facts.length) facts.push("Every gate passes.");
  const oneJudge = d.decide.length && d.counts && d.decide.length === d.counts.broke && new Set(d.decide.map((x) => x.judge)).size === 1;
  const heading = d.state === "hold" ? (oneJudge ? "Don't merge yet. One judge explains every break." : "Don't merge yet.") : d.state === "safe" ? (d.counts && d.counts.broke === 0 && d.counts.fixed ? `Safe to merge. ${d.counts.fixed} ${d.counts.fixed === 1 ? "task was" : "tasks were"} fixed and nothing broke.` : "Safe to merge: every gate passes.") : "No runs yet.";
  const [level, word] = LEVEL[d.state];
  const primary = d.decide.length ? h("a", { class: "btn primary", href: "#/ship/decide" }, `Decide ${d.decide.length} ${d.decide.length === 1 ? "reply" : "replies"}`) : h("a", { class: "btn primary", href: "#/ship" }, "See what changed");
  return h("div", { class: "home-verdict" },
    h("p", { class: "eyebrow-status" }, statusWord(level, word), gated.length ? [h("span", { "aria-hidden": "true" }, " · "), `${failing.length} of ${gated.length} `, term("gate", gated.length === 1 ? "gate" : "gates"), failing.length === 1 ? " fails" : " fail"] : null),
    h("h1", { class: "home-heading" }, heading),
    h("p", { class: "home-lead" }, facts.join(" ")),
    h("p", { class: "home-source" }, "From ", h("span", { class: "mono" }, `runs/${d.run.run_id}.json`), d.previous ? [" and ", h("span", { class: "mono" }, `runs/${d.previous.run_id}.json`)] : null, ". No AI wrote this."),
    h("div", { class: "home-actions" }, primary, d.decide.length ? h("a", { class: "btn quiet", href: "#/ship" }, "See what changed") : null));
}

function firstRun(d) {
  const labelled = d.labels.total;
  const step = (n, done, title, body, action) => h("li", { class: `fr-step${done ? " done" : ""}` },
    h("span", { class: "fr-n", "aria-hidden": "true" }, done ? "✓" : String(n)),
    h("div", { class: "fr-body" }, h("span", { class: "fr-title" }, title, done ? h("span", { class: "sr-only" }, " (done)") : null), h("p", {}, ...body), action ?? null));
  const hasBatch = state.batches.length > 0;
  return h("div", { class: "column home" },
    h("p", { class: "eyebrow-status" }, statusWord("none", "No runs yet")),
    h("h1", { class: "home-heading" }, "Let's find out what your agent gets wrong."),
    h("p", { class: "home-lead" }, "Four steps. The first is reading real conversations, because the failures that matter are the ones you would only spot by reading."),
    h("ol", { class: "fr-steps" },
      step(1, hasBatch, "Bring your conversations", hasBatch ? [`Batch ${state.batches[0].name}: ${state.batches[0].items} conversations to read.`] : ["Point litmustest at a JSONL file of your agent's conversations."], hasBatch ? null : h("code", { class: "mono" }, "litmustest ingest traces/your-agent.jsonl")),
      step(2, labelled >= 20, "Label 20 of them", ["Read each one and say Pass or Fail, with a note in your own words. Only a person can do this."], h("a", { class: "btn primary", href: "#/teach/label" }, "Start labeling")),
      step(3, false, "Name what goes wrong", ["Group your notes into ", term("failure_mode", "failure modes"), ". With a model key, Claude proposes the groups for you to accept."], h("a", { href: "#/teach/group" }, "Group notes")),
      step(4, false, "Turn failures into tests and run them", ["Each failure becomes a ", term("task"), " with checks. The first run gives you a pass rate with its margin of error."], h("code", { class: "mono" }, "litmustest run"))));
}

export async function renderHome() {
  const seq = state.seq; const page = $("#page");
  const d = await api("/api/home"); if (stale(seq)) return;
  if (d.state === "no_runs") { page.replaceChildren(firstRun(d)); return; }
  const corrected = d.gates.some((g) => g.rate !== null);
  const up = d.up_next;
  page.replaceChildren(h("div", { class: "column home" },
    h("section", { class: "home-top", "aria-label": "Verdict" },
      verdict(d),
      h("section", { class: "home-gates", "aria-label": "Gates" },
        h("h2", { class: "label" }, term("gate", "Gates")),
        ...d.gates.map(gateRow),
        corrected ? h("p", { class: "caption muted" }, "Pass rates count trusted judges only, ", term("corrected_rate", "corrected for their known mistakes"), ".") : null)),
    h("section", { class: "up-next", "aria-label": "Up next" },
      h("div", { class: "section-head" }, h("h2", {}, term("up_next", "Up next")), up.length ? h("span", { class: "caption muted" }, "Most urgent first") : null),
      up.length ? h("div", { class: "up-list" }, ...up.map(upRow)) : h("p", { class: "empty-quiet" }, "Nothing needs you. Every judge is trusted, no task is flaky or broken, and your last batch is labeled. A good moment to ", h("a", { href: "#/teach/label" }, "label a fresh batch"), "."))));
}
