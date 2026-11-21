// litmustest dashboard: screens/judges.js
import { header, statusWord, step, teachHead, teachRail } from "../components.js";
import { command, num, plain, rate, term } from "../explainer.js";
import { $, ago, api, h } from "../lib/dom.js";
import { stale, state } from "../lib/state.js";
import { review } from "./review.js";
import { refreshHealth } from "../shell.js";

// ---------------- judges (design/mockups/v2/JudgesP): every judge with its status, its rates with their ranges, and one action;
// then the failure modes with no judge yet, each with a way to start one.
const JSTATUS = { trusted: ["good", "Trusted"], stale: ["warn", "Stale"], dev: ["warn", "Below the bar"], untested: ["none", "Untested"] };
export async function renderJudges() {
  const seq = state.seq; const page = $("#page");
  const d = await api("/api/judges"); if (stale(seq)) return;
  const enc = encodeURIComponent;
  const trusted = d.judges.filter((j) => j.status === "trusted").length;
  const status = h("span", { class: "status", "aria-live": "polite" });
  const draftCheck = async (mode) => { status.textContent = `Drafting a code check for ${mode}…`; status.className = "status"; try { const r = await api(`/api/checks/${enc(mode)}/draft`, { method: "POST", body: "{}" }); status.textContent = `${r.files.length} files in Pending changes`; status.className = "status good"; await refreshHealth(); renderJudges(); } catch (e) { status.textContent = e.message; status.className = "status bad"; } };
  const action = (j) => j.status === "stale" ? "Run on dev set" : j.status === "dev" ? "Label more, then run" : j.status === "untested" ? "Run on dev set" : "Open";
  const rows = d.judges.map((j) => { const [lv, word] = JSTATUS[j.status] ?? ["none", j.status]; return h("tr", {},
    h("td", {}, h("a", { class: "mono", href: `#/teach/judges/${enc(j.name)}` }, j.name)),
    h("td", {}, num(j.status === "trusted" ? "trusted" : j.status === "stale" ? "stale" : "calibration", "judge", { judge: j.name }, statusWord(lv, word))),
    h("td", { class: "num" }, j.dev ? [rate(j.dev.tpr, j.dev.tpr_ci), " / ", rate(j.dev.tnr, j.dev.tnr_ci)] : "—"),
    h("td", { class: "num" }, j.test ? [rate(j.test.tpr, j.test.tpr_ci), " / ", rate(j.test.tnr, j.test.tnr_ci)] : "—"),
    h("td", { class: "num" }, String(j.labels)),
    h("td", { class: "mono judge-model" }, `${j.model} · v${j.version}`),
    h("td", { class: "row-action" }, h("a", { href: `#/teach/judges/${enc(j.name)}` }, action(j)))); });
  const sev = (name) => state.modes.find((m) => m.name === name)?.severity ?? "";
  const cands = d.candidates.slice().sort((a, b) => ["high", "med", "low", ""].indexOf(sev(a.name)) - ["high", "med", "low", ""].indexOf(sev(b.name)));
  page.replaceChildren(h("div", { class: "column" },
    teachRail("judges"),
    teachHead(`${trusted} of ${d.judges.length} ${d.judges.length === 1 ? "judge" : "judges"} can be trusted`, [`A judge counts in scores and gates only once it passes its `, term("test_set", "test set"), `, run once, with `, term("tpr", "TPR"), " and ", term("tnr", "TNR"), ` at ${d.threshold}% or more. Code checks need no calibrating.`], status),
    h("section", { class: "judges-list", "aria-label": "Judges" }, d.judges.length ? h("table", { class: "plain" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Judge"), h("th", { scope: "col" }, "Status"), h("th", { scope: "col", class: "num" }, term("dev_set", "Dev"), " TPR / TNR"), h("th", { scope: "col", class: "num" }, "Test TPR / TNR"), h("th", { scope: "col", class: "num" }, "Labels"), h("th", { scope: "col" }, "Model"), h("th", { scope: "col" }, h("span", { class: "sr-only" }, "Action")))),
      h("tbody", {}, ...rows)) : h("p", { class: "empty-quiet" }, "No judges yet. Start one for a failure mode below.")),
    h("section", { class: "judges-list", "aria-label": "Failure modes without a judge" },
      h("div", { class: "section-head" }, h("h2", {}, "Failure modes with no judge"), h("span", { class: "caption muted" }, "Code checks first, where a function can decide")),
      cands.length ? h("table", { class: "plain" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Failure mode"), h("th", { scope: "col" }, "Severity"), h("th", { scope: "col", class: "num" }, "Labels"), h("th", { scope: "col" }, h("span", { class: "sr-only" }, "Actions")))),
        h("tbody", {}, ...cands.map((c) => h("tr", {},
          h("td", {}, h("a", { class: "mono", href: `#/teach/modes/${enc(c.name)}` }, c.name)),
          h("td", {}, sev(c.name) || "—"),
          h("td", { class: "num" }, num(c.name, "failure_mode", { mode: c.name }, String(c.labels))),
          h("td", { class: "row-action" }, c.has_code_check ? h("span", { class: "muted" }, "Has a code check") : null,
            h("a", { href: `#/teach/judges/new?mode=${enc(c.name)}` }, "New judge"),
            h("button", { type: "button", class: "linklike", disabled: c.labels < 4, title: c.labels < 4 ? "Needs at least 4 labels" : "", onclick: () => draftCheck(c.name) }, "Draft code check"))))))
        : h("p", { class: "empty-quiet" }, d.judges.length ? "Every failure mode has a judge." : h("span", {}, "No failure modes yet. ", h("a", { href: "#/teach/group" }, "Group your notes"), " first.")))));
}

// ---------------- new judge (design/mockups/v2/NewJudgeP): Claude drafts a judge for one failure mode from its definition
// and labels; the files land in Pending changes and the judge starts untrusted.
export async function renderNewJudge(mode) {
  const seq = state.seq; const page = $("#page");
  const [d, modes] = await Promise.all([api("/api/judges"), api("/api/modes")]); if (stale(seq)) return;
  const enc = encodeURIComponent;
  const m = modes.failure_modes.find((x) => x.name === mode);
  const status = h("p", { class: "status", "aria-live": "polite" });
  if (!m) { page.replaceChildren(h("div", { class: "column" }, teachRail("judges"), teachHead("New judge", "Pick a failure mode that has no judge yet."), h("ul", { class: "plain-list" }, ...d.candidates.map((c) => h("li", {}, h("a", { class: "mono", href: `#/teach/judges/new?mode=${enc(c.name)}` }, c.name), ` · ${c.labels} labels`))))); return; }
  if (d.judges.some((j) => j.name === mode)) { location.replace(`#/teach/judges/${enc(mode)}`); return; }
  const fails = Number(m.fail_labels ?? 0), labels = Number(m.labels ?? 0);
  const enough = labels >= 6;
  const key = Boolean(state.health?.model_key);
  const draft = async (btn) => { btn.disabled = true; status.className = "status"; status.textContent = `Claude is drafting the ${mode} judge from its definition and ${labels} labels…`;
    try { const r = await api(`/api/judges/${enc(mode)}/draft`, { method: "POST", body: "{}" }); await refreshHealth(); status.className = "status good"; status.textContent = `${r.files.length} files in Pending changes.`; location.hash = `#/teach/judges/${enc(mode)}`; }
    catch (e) { status.className = "status bad"; status.textContent = e.message; btn.disabled = false; } };
  page.replaceChildren(h("div", { class: "column" },
    teachRail("judges"),
    teachHead(["New judge for ", h("span", { class: "mono" }, mode)], ["A ", term("judge"), " grades one failure mode with Pass, Fail or Unknown. It starts untrusted and counts only once it passes its test set."]),
    h("dl", { class: "facts" },
      h("dt", {}, "Failure mode"), h("dd", {}, h("a", { class: "mono", href: `#/teach/modes/${enc(mode)}` }, mode), m.severity ? ` · ${m.severity}` : ""),
      h("dt", {}, "Definition"), h("dd", {}, m.definition),
      h("dt", {}, "Your labels"), h("dd", {}, `${fails} Fail and ${labels - fails} Pass. `, fails < 10 ? "With so few failures the test set will hold only a handful, so its rates will have wide ranges. Labeling more failures first narrows them." : "")),
    h("p", { class: "caption muted" }, "Examples shown to the judge come only from the train split; the dev split measures it; the test set is held back until you run it once."),
    h("div", { class: "home-actions" },
      key ? h("button", { type: "button", class: "btn primary", disabled: !enough, title: enough ? "" : "Needs at least 6 labels", onclick: (e) => draft(e.currentTarget) }, "Draft the judge with Claude") : null,
      h("a", { class: key ? "btn quiet" : "btn primary", href: "#/teach/label" }, "Label more first")),
    key ? null : h("p", { class: "caption muted" }, "Drafting needs a model key: set ", h("span", { class: "mono" }, "ANTHROPIC_API_KEY"), " in the shell that runs ", h("span", { class: "mono" }, "litmustest serve"), ", or run ", h("span", { class: "mono" }, `litmustest draft-judge ${mode}`), " in a terminal that has one."),
    status));
}

export const judgePage = { name: null, mode: "form", draft: null, hashes: null, state: "", cls: "", conflict: null };
export async function renderJudge(name) {
  const seq = state.seq; const page = $("#page");
  let d; try { d = await api(`/api/judges/${encodeURIComponent(name)}`); } catch (e) { page.replaceChildren(h("div", { class: "column" }, header("Judge not found", e.message))); return; }
  if (stale(seq)) return;
  if (judgePage.name !== name || !judgePage.hashes || judgePage.hashes.prompt !== d.prompt.hash || judgePage.hashes.judge !== d.judge.hash) {
    if (judgePage.name !== name || judgePage.state !== "Not saved · edited") { judgePage.draft = { prompt: d.prompt.content, model: d.judge.data.model, inputs: [...(d.judge.data.inputs ?? [])], few_shot: (d.judge.data.few_shot ?? []).map((s) => ({ ...s })), yaml: d.judge.content }; judgePage.state = "Saved · in sync with disk"; judgePage.cls = ""; }
    judgePage.name = name; judgePage.hashes = { prompt: d.prompt.hash, judge: d.judge.hash };
  }
  const dr = judgePage.draft; const cal = d.calibration; const dev = cal?.dev; const test = cal?.test;
  const setState = (t, c) => { judgePage.state = t; judgePage.cls = c; stateEl.textContent = t; stateEl.className = `save-state ${c}`; };
  const dirty = () => { if (!judgePage.state.startsWith("Not saved")) setState("Not saved · edited", ""); };
  const stateEl = h("span", { class: `save-state ${judgePage.cls}`, "aria-live": "polite" }, judgePage.state);
  const steps = [["Edit the prompt", "criteria, examples, model"], [`Dev ≥ ${d.threshold}/${d.threshold}`, dev?.tpr !== undefined ? `TPR ${dev.tpr} · TNR ${dev.tnr}` : "not run yet"], ["Test set, once", d.test_done ? `TPR ${test.tpr} · TNR ${test.tnr}` : `${d.splits.test} held-out traces`], ["Trusted", d.status === "trusted" ? "verdicts count in gates" : "not yet"]];
  const stepper = h("ol", { class: "stepper", "aria-label": "Calibration steps" }, ...steps.map((s, i) => h("li", { class: i + 1 < d.step ? "done" : i + 1 === d.step ? "current" : "", "aria-current": i + 1 === d.step ? "step" : undefined }, h("span", { class: "n" }, i + 1 < d.step ? "✓" : String(i + 1)), h("span", { class: "t" }, h("span", {}, s[0]), h("span", {}, s[1])))));
  const banner = d.status === "stale" ? h("div", { class: "banner", role: "status" }, h("span", {}, h("strong", {}, `The ${cal.stale_reason === "model_changed" ? "model" : "prompt"} changed after the last test pass.`), ` Those test numbers no longer describe this judge, so its verdicts are excluded from scores and gates. Reach ${d.threshold}/${d.threshold} on dev, then run the test set once.`)) : d.status === "trusted" ? h("div", { class: "banner good", role: "status" }, h("span", {}, h("strong", {}, "Trusted."), ` Test TPR ${test.tpr} / TNR ${test.tnr} on ${cal.splits.test.trace_ids.length} held-out traces, run ${ago(test.ran_at)}. Editing the prompt or model will mark it stale.`)) : null;

  // ---- definition editor
  const save = async (keepMine = false) => {
    const promptChanged = dr.prompt !== d.prompt.content;
    try {
      let r;
      if (judgePage.mode === "files") r = await api("/api/file", { method: "PUT", body: JSON.stringify({ path: d.judge.path, content: dr.yaml, base_hash: keepMine ? judgePage.conflict : d.judge.hash }) });
      if (promptChanged) r = await api("/api/file", { method: "PUT", body: JSON.stringify({ path: d.prompt.path, content: dr.prompt.endsWith("\n") ? dr.prompt : dr.prompt + "\n", base_hash: keepMine ? judgePage.conflict : d.prompt.hash }) });
      if (judgePage.mode === "form") { const data = { ...d.judge.data, model: dr.model, inputs: dr.inputs, few_shot: dr.few_shot }; if (promptChanged) data.prompt_hash = (await api(`/api/file?path=${encodeURIComponent(d.prompt.path)}`)).hash; r = await api("/api/file", { method: "PUT", body: JSON.stringify({ path: d.judge.path, data, base_hash: keepMine ? judgePage.conflict : (promptChanged ? (await api(`/api/file?path=${encodeURIComponent(d.judge.path)}`)).hash : d.judge.hash) }) }); }
      setState(`Checked and saved to branch · ${new Date().toLocaleTimeString()}`, "good"); judgePage.hashes = null; await refreshHealth(); await renderJudge(name);
    } catch (e) {
      if (e.status === 409) { judgePage.conflict = e.body.current_hash; setState("Not saved · conflict", "bad"); conflictRow.hidden = false; }
      else setState(`Not saved · ${e.body?.problems?.[0]?.message ?? e.message}`, "bad");
    }
  };
  const conflictRow = h("div", { class: "row-actions", hidden: true }, h("span", { class: "caption muted" }, "A file changed on disk since you opened it."), h("button", { type: "button", class: "linklike", onclick: () => { judgePage.name = null; judgePage.state = ""; renderJudge(name); } }, "Reload file"), h("button", { type: "button", class: "linklike", onclick: () => save(true) }, "Keep mine"));
  const promptEl = h("textarea", { class: "note prompt", "aria-label": "Prompt", oninput: (e) => { dr.prompt = e.target.value; dirty(); } }, dr.prompt);
  const modelEl = h("input", { class: "text mono", "aria-label": "Judge model (pinned)", value: dr.model, oninput: (e) => { dr.model = e.target.value; dirty(); } });
  const inputsEl = h("div", { class: "chips", role: "group", "aria-label": "Inputs passed to the judge" }, ...["transcript", "output", "input", "tool_calls", "state", "reference"].map((i) => h("button", { type: "button", class: "chip", "aria-pressed": dr.inputs.includes(i) ? "true" : "false", onclick: (e) => { dr.inputs = dr.inputs.includes(i) ? dr.inputs.filter((x) => x !== i) : [...dr.inputs, i]; e.target.setAttribute("aria-pressed", dr.inputs.includes(i) ? "true" : "false"); dirty(); } }, i)));
  const shotsEl = h("div", {});
  const drawShots = () => shotsEl.replaceChildren(...[...dr.few_shot.map((s, i) => h("div", { class: "shot" }, h("span", { class: `pill ${s.label === "Fail" ? "bad" : "good"}` }, s.label), h("a", { class: "mono", href: `#/review/${encodeURIComponent(state.batches[0]?.name ?? "")}/${encodeURIComponent(s.trace_id)}` }, s.trace_id), h("span", { class: "excerpt", title: s.note ?? "" }, s.note ?? "(no note)"), h("button", { type: "button", class: "linklike danger", onclick: () => { dr.few_shot.splice(i, 1); drawShots(); dirty(); } }, "Remove"))), dr.few_shot.length ? null : h("p", { class: "muted", style: "margin:0;font-size:13px" }, "No examples yet.")].filter(Boolean));
  drawShots();
  let pickerOpen = false; const pickerEl = h("div", {});
  const openPicker = async () => { pickerOpen = !pickerOpen; if (!pickerOpen) { pickerEl.replaceChildren(); return; } const t = await api(`/api/judges/${encodeURIComponent(name)}/train`); pickerEl.replaceChildren(h("div", { class: "card", style: "padding:12px;gap:4px" }, h("span", { class: "caption muted" }, `Train split · ${t.train.length} traces. Dev and test are never offered.`), ...t.train.filter((x) => !dr.few_shot.some((s) => s.trace_id === x.trace_id)).map((x) => h("div", { class: "shot" }, h("span", { class: `pill ${x.label === "Fail" ? "bad" : "good"}` }, x.label ?? "?"), h("span", { class: "mono" }, x.trace_id), h("span", { class: "excerpt", title: x.excerpt }, x.note ?? x.excerpt), h("button", { type: "button", class: "linklike", onclick: () => { dr.few_shot.push({ trace_id: x.trace_id, label: x.label, ...(x.note ? { note: x.note } : {}) }); drawShots(); dirty(); pickerOpen = false; pickerEl.replaceChildren(); } }, "Add"))))); };
  const yamlEl = h("textarea", { class: "note prompt", "aria-label": "judge.yaml", oninput: (e) => { dr.yaml = e.target.value; dirty(); } }, dr.yaml);
  const formView = h("div", { style: "display:flex;flex-direction:column;gap:12px" },
    h("label", { class: `field ${judgePage.cls}` }, h("span", { class: "label-row" }, h("span", {}, "Prompt (prompt.md)"), stateEl), promptEl),
    h("div", { class: "two-col" }, h("label", { class: "field", style: "flex:1 1 240px" }, h("span", {}, "Judge model (pinned)"), modelEl), h("div", { class: "field", style: "flex:2 1 300px" }, h("span", {}, "Inputs passed to the judge"), inputsEl)),
    h("div", { class: "field" }, h("div", { class: "card-head" }, h("span", {}, "Few-shot examples ", h("span", { class: "faint" }, `· from the train split only · ${dr.few_shot.length} of ${d.splits.train}`)), h("button", { type: "button", class: "linklike", onclick: openPicker }, "+ Add example from train split")), shotsEl, pickerEl));
  const filesView = h("div", { style: "display:flex;flex-direction:column;gap:12px" }, h("label", { class: `field ${judgePage.cls}` }, h("span", { class: "label-row" }, h("span", {}, "judge.yaml"), stateEl.cloneNode(true)), yamlEl), h("label", { class: "field" }, h("span", {}, "prompt.md"), promptEl.cloneNode(true)));
  const editorBody = h("div", {}, judgePage.mode === "form" ? formView : filesView);
  const definition = h("section", { class: "card main", "aria-label": "Judge definition" },
    h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, "Definition"), h("div", { class: "caption muted mono", style: "font-weight:400;font-size:12px" }, `evals/graders/judges/${name}/`)), h("div", { class: "toggle", role: "group", "aria-label": "Editor mode" }, h("button", { type: "button", "aria-pressed": judgePage.mode === "form" ? "true" : "false", onclick: () => { judgePage.mode = "form"; renderJudge(name); } }, "Form"), h("button", { type: "button", "aria-pressed": judgePage.mode === "files" ? "true" : "false", onclick: () => { judgePage.mode = "files"; renderJudge(name); } }, "Files"))),
    editorBody,
    h("div", { class: "verdict" }, h("button", { type: "button", class: "btn primary", onclick: () => save() }, "Save"), h("span", { class: "caption muted", style: "align-self:center" }, `Edits write to the files on branch ${state.health?.branch ?? ""} after passing the checks below. Saving the prompt or model marks a trusted judge stale.`)),
    conflictRow,
    h("div", { class: "field" }, h("span", {}, "Checks run on every save"), ...d.checks.map((c) => h("div", { class: `lint ${c.ok ? "ok" : "no"}` }, h("span", { class: "mark", "aria-hidden": "true" }, c.ok ? "✓" : "!"), h("span", {}, c.text)))));

  // ---- calibration
  const m = dev?.matrix; const matrix = m ? h("div", { class: "matrix", role: "table", "aria-label": "Confusion matrix, human label by judge verdict" }, h("span", { role: "cell" }), h("span", { role: "columnheader" }, "Judge Pass"), h("span", { role: "columnheader" }, "Judge Fail"), h("span", { role: "rowheader" }, "Human Pass"), h("span", { role: "cell", class: "good" }, String(m.tn)), h("span", { role: "cell", class: "bad" }, String(m.fp)), h("span", { role: "rowheader" }, "Human Fail"), h("span", { role: "cell", class: "bad" }, String(m.fn)), h("span", { role: "cell", class: "good" }, String(m.tp))) : null;
  const kpi = (label, v, ci) => h("div", {}, h("span", {}, term(label.toLowerCase(), label)), h("span", { class: v === undefined ? "" : v >= d.threshold ? "good" : "bad" }, v === undefined ? "—" : num(label.toLowerCase(), "judge", { judge: name }, `${v}%`)), ci ? h("span", { class: "ci" }, `${ci.low}–${ci.high} · 95%`) : null);
  const runs = (dev?.runs ?? []);
  const chart = runs.length ? (() => { const w = 400, hh = 100, x0 = 48, x1 = 380; const xs = runs.map((_, i) => runs.length > 1 ? x0 + 22 + ((x1 - x0 - 44) * i) / (runs.length - 1) : (x0 + x1) / 2); const y = (v) => 84 - (64 * v) / 100; const path = (k) => runs.map((r, i) => `${i ? "L" : "M"}${xs[i].toFixed(1)} ${y(r[k]).toFixed(1)}`).join(" "); return h("svg", { viewBox: `0 0 ${w} ${hh}`, width: "100%", height: hh, role: "img", "aria-label": `TPR and TNR across ${runs.length} dev runs against the ${d.threshold}% target`, html: `<line x1="${x0}" y1="${y(d.threshold)}" x2="${x1}" y2="${y(d.threshold)}" stroke="var(--good)" stroke-dasharray="4 4"/><text x="${x1}" y="${y(d.threshold) - 6}" text-anchor="end" font-size="11" fill="var(--good)">${d.threshold}% target</text><path d="${path("tpr")}" fill="none" stroke="var(--blue)" stroke-width="2"/><path d="${path("tnr")}" fill="none" stroke="var(--warn)" stroke-width="2" stroke-dasharray="5 3"/>${runs.map((r, i) => `<text x="${xs[i]}" y="96" text-anchor="middle" font-size="11" fill="var(--ink-muted)">v${r.version ?? "?"}</text>`).join("")}<text x="6" y="${y(runs[runs.length - 1].tpr)}" font-size="11" font-weight="600" fill="var(--blue)">TPR</text><text x="6" y="${y(runs[runs.length - 1].tnr) + 12}" font-size="11" font-weight="600" fill="var(--warn)">TNR</text>` }); })() : null;
  const prog = h("span", { class: "progress-inline", "aria-live": "polite" }, d.running ? `Running ${d.running.split}: ${d.running.done}/${d.running.total}` : "");
  const runSplit = async (split) => { try { await api(`/api/judges/${encodeURIComponent(name)}/calibrate`, { method: "POST", body: JSON.stringify({ split }) }); prog.textContent = `Running ${split}…`; } catch (e) { prog.textContent = e.body?.message ?? e.message; } };
  const runDev = command("judges.runDev", { label: () => "Run on dev set", enabled: () => !d.running && d.splits.dev > 0, reason: () => (d.running ? "A run is in progress." : "No dev labels yet: label traces for this failure mode."), run: () => runSplit("dev") });
  const runTest = command("judges.runTest", { label: () => (d.test_done ? "Test set ran" : "Run test set once"), enabled: () => d.can_run_test && !d.running, reason: () => (d.test_done ? "The test set already ran for this prompt and model." : `Unlocks when dev TPR and TNR both reach ${d.threshold}%.`), run: () => { if (confirm(`Run the held-out test set once (${d.splits.test} traces)? It cannot be re-run for this prompt.`)) runSplit("test"); } });
  const calibration = h("section", { class: "card side", "aria-label": "Calibration" },
    h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, term("calibration", "Calibration"), " · ", term("dev_set", "dev set")), h("div", { class: "caption muted" }, `${d.splits.dev} dev traces · ${d.labels} labels (${d.fail_labels} Fail) · train ${d.splits.train} / dev ${d.splits.dev} / test ${d.splits.test}`)), h("button", { type: "button", class: "btn", disabled: !runDev.enabled(), onclick: runDev.run }, runDev.label())),
    prog,
    matrix ?? h("p", { class: "muted", style: "margin:0" }, "Dev has not run yet."),
    dev?.tpr !== undefined ? h("div", { class: "kpis" }, kpi("TPR", dev.tpr, dev.tpr_ci), kpi("TNR", dev.tnr, dev.tnr_ci), h("div", {}, h("span", {}, term("unknown", "Unknown")), h("span", {}, num("unknown", "judge", { judge: name }, String(m?.unknown ?? 0))))) : null,
    dev?.tpr !== undefined ? plain("tpr", "judge", { judge: name }) : null,
    chart ? h("div", { class: "field" }, h("span", {}, "TPR and TNR by version (dev)"), chart) : null,
    h("div", { class: "verdict", style: "align-items:center" }, h("button", { type: "button", class: "btn primary", disabled: !runTest.enabled(), onclick: runTest.run }, runTest.label()), h("span", { class: "caption muted" }, num("test_set", "judge", { judge: name }, d.test_done ? `Test: TPR ${test.tpr} / TNR ${test.tnr} · ${ago(test.ran_at)}` : d.can_run_test ? `Unlocked. Test split: ${d.splits.test} traces the judge has never seen.` : `Unlocks at step 3. Test split: ${d.splits.test} traces.`))));
  const dis = (cal?.disagreements ?? []);
  const disagreements = h("section", { class: "card", "aria-label": "Disagreements" }, h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, "Disagreements on dev"), h("div", { class: "caption muted" }, `${dis.length} traces where judge and human differ · a disputed verdict becomes a label`)), h("a", { href: "#/review" }, "Open queue")),
    dis.length ? h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Trace"), h("th", { scope: "col" }, "Human"), h("th", { scope: "col" }, "Judge"), h("th", { scope: "col" }, "Judge's critique"))), h("tbody", {}, ...dis.slice(0, 30).map((x) => h("tr", {}, h("td", {}, h("a", { class: "mono", href: `#/review/${encodeURIComponent(state.batches[0]?.name ?? "")}/${encodeURIComponent(x.trace_id)}` }, x.trace_id)), h("td", {}, h("span", { class: `pill ${x.human === "Fail" ? "bad" : "good"}` }, x.human)), h("td", {}, h("span", { class: `pill ${x.judge === "Fail" ? "bad" : x.judge === "Pass" ? "good" : ""}` }, x.judge)), h("td", { style: "font-size:13px;color:var(--ink-muted)" }, x.critique ?? ""))))) : h("p", { class: "muted", style: "margin:0" }, "None recorded."));
  page.replaceChildren(h("div", { class: "column" },
    teachRail("judges"),
    h("header", { class: "page-header" }, h("div", { class: "titles" }, h("div", { class: "title-row" }, h("h1", { class: "teach-title mono" }, name), h("span", { class: `pill ${d.status === "trusted" ? "good" : d.status === "stale" || d.status === "dev" ? "warn" : ""}` }, `${d.label.replace(/^Judge · /, "")} · v${d.judge.data.version ?? 1}`)), h("p", { class: "subtitle" }, d.mode?.definition ?? "", ` Used by ${d.used_by.length} task${d.used_by.length === 1 ? "" : "s"}.`)), h("div", { class: "verdict" }, h("a", { href: `#/modes/${encodeURIComponent(name)}`, class: "btn" }, "Open failure mode"))),
    stepper, banner,
    h("div", { class: "two-col" }, definition, calibration),
    disagreements));
}
