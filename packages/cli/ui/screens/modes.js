// litmustest dashboard: screens/modes.js
import { step } from "../components.js";
import { count, num, plain, term } from "../explainer.js";
import { $, api, h } from "../lib/dom.js";
import { stale, state } from "../lib/state.js";
import { review } from "./review.js";
import { refreshHealth } from "../shell.js";

// ---------------- failure modes
export const modesPage = { sel: null, draft: null, state: "", stateClass: "", hash: null };
export function spark(values, w = 64, hgt = 20) {
  if (!values.length) return "";
  const max = Math.max(1, ...values); const step = values.length > 1 ? (w - 4) / (values.length - 1) : 0;
  return values.map((v, i) => `${i ? "L" : "M"}${(2 + i * step).toFixed(1)} ${(hgt - 2 - ((hgt - 4) * v) / max).toFixed(1)}`).join(" ");
}
export async function renderModes(selName) {
  const seq = state.seq; const page = $("#page");
  const { failure_modes: modes } = await api("/api/modes");
  if (stale(seq)) return;
  const live = modes.filter((m) => !m.retired);
  const max = Math.max(1, ...live.map((m) => (m.has_runs ? m.run_fails : m.fail_labels)));
  const sel = modes.find((m) => m.name === selName) ?? live[0] ?? modes[0];
  if (sel && (modesPage.sel !== sel.name || modesPage.hash !== sel.hash)) { modesPage.sel = sel.name; modesPage.hash = sel.hash; modesPage.draft = { definition: sel.definition, severity: sel.severity, owner: sel.owner ?? "" }; modesPage.state = "Saved · in sync with disk"; modesPage.stateClass = ""; }
  const pick = (name) => { location.hash = `#/modes/${encodeURIComponent(name)}`; };
  const rows = live.map((m) => { const count = m.has_runs ? m.run_fails : m.fail_labels; const t = m.trend; const dir = t.length > 1 ? Math.sign(t[t.length - 1] - t[0]) : 0;
    return h("button", { type: "button", class: "pareto-row", "aria-pressed": sel && m.name === sel.name ? "true" : "false", onclick: () => pick(m.name) },
      h("span", { class: "mono" }, m.name), h("span", { class: "bar" }, h("span", { style: `width:${(100 * count) / max}%` })), h("span", { class: "n" }, String(count)),
      h("span", { class: `pill ${m.severity === "high" ? "bad" : m.severity === "med" ? "warn" : ""}` }, m.severity === "med" ? "Med" : m.severity[0].toUpperCase() + m.severity.slice(1)),
      h("span", { class: `pill ${m.grader.status === "trusted" ? "good" : m.grader.status === "stale" || m.grader.status === "dev" ? "warn" : ""}` }, m.grader.label),
      m.has_runs ? h("svg", { viewBox: "0 0 64 20", width: "64", height: "20", role: "img", "aria-label": `${t[t.length - 1]} fails in the latest run, ${dir > 0 ? "rising" : dir < 0 ? "falling" : "flat"} over ${t.length} runs`, class: `spark ${dir > 0 ? "up" : dir < 0 ? "down" : ""}`, html: `<path d="${spark(t)}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` }) : h("span", { class: "faint", style: "font-size:12px" }, "no runs")); });
  const pareto = h("section", { class: "card main", "aria-label": "Pareto" },
    h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, "What breaks most"), h("div", { class: "caption muted" }, live[0]?.has_runs ? "Failed checks in the latest run by failure mode" : `Fail labels by failure mode · ${modes.reduce((a, m) => a + m.labels, 0)} labels so far`))),
    h("div", { class: "pareto-head" }, h("span", {}, "Mode"), h("span"), h("span", { style: "text-align:right" }, "Fails"), h("span", {}, term("severity", "Severity")), h("span", {}, "Grader"), h("span", { style: "text-align:right" }, "Trend")),
    ...(rows.length ? rows : [h("p", { class: "muted", style: "margin:0" }, "No failure modes yet. Label traces in the review queue, then ask Claude to regroup your notes.")]),
    h("span", { class: "caption muted" }, "Trend shows the last 6 runs. Severity is set by a person; grader status comes from the files."));

  let editor = h("section", { class: "card side", "aria-label": "Selected failure mode" }, h("p", { class: "muted", style: "margin:0" }, "Select a failure mode."));
  if (sel) {
    const d = modesPage.draft;
    const setState = (text, cls) => { modesPage.state = text; modesPage.stateClass = cls; stateEl.textContent = text; stateEl.className = `save-state ${cls}`; for (const f of fields) f.className = `field ${cls}`; };
    const stateEl = h("span", { class: `save-state ${modesPage.stateClass}`, "aria-live": "polite" }, modesPage.state);
    const dirty = () => { if (modesPage.state.startsWith("Saved") || modesPage.state.startsWith("Checked")) setState("Not saved · edited", ""); };
    const defEl = h("textarea", { class: "note", rows: 4, "aria-label": "Definition", oninput: (e) => { d.definition = e.target.value; dirty(); } }, d.definition);
    const sevEl = h("select", { class: "select", "aria-label": "Severity", onchange: (e) => { d.severity = e.target.value; dirty(); } }, ...["high", "med", "low"].map((v) => h("option", { value: v, selected: v === d.severity }, v)));
    const ownerEl = h("input", { class: "text", "aria-label": "Owner", value: d.owner, placeholder: "team or person", oninput: (e) => { d.owner = e.target.value; dirty(); } });
    const fields = [h("label", { class: `field ${modesPage.stateClass}` }, h("span", { class: "label-row" }, h("span", {}, "Definition"), stateEl), defEl), h("label", { class: `field ${modesPage.stateClass}` }, h("span", {}, term("severity", "Severity")), sevEl), h("label", { class: `field ${modesPage.stateClass}` }, h("span", {}, "Owner"), ownerEl)];
    const build = (extra = {}) => { const o = { name: sel.name, definition: d.definition.trim(), severity: d.severity }; if (d.owner.trim()) o.owner = d.owner.trim(); if (sel.examples?.length) o.examples = sel.examples; o.created = sel.created; if (sel.retired) o.retired = sel.retired; if (sel.merged_into) o.merged_into = sel.merged_into; Object.assign(o, extra); return o; };
    const save = async (data, keepMine = false) => {
      try {
        const r = await api("/api/file", { method: "PUT", body: JSON.stringify({ path: sel.path, data, base_hash: keepMine ? conflictHash : modesPage.hash }) });
        modesPage.hash = r.hash; setState(`Checked and saved to branch · ${new Date().toLocaleTimeString()}`, "good"); await refreshHealth(); await renderModes(sel.name);
      } catch (e) {
        if (e.status === 409) { conflictHash = e.body.current_hash; setState("Not saved · conflict", "bad"); conflictRow.hidden = false; }
        else setState(`Not saved · ${e.body?.problems?.[0]?.message ?? e.message}`, "bad");
      }
    };
    let conflictHash = null;
    const conflictRow = h("div", { class: "row-actions", hidden: true }, h("span", { class: "caption muted" }, `${sel.path} changed on disk since it was loaded.`), h("button", { type: "button", class: "linklike", onclick: () => { modesPage.sel = null; renderModes(sel.name); } }, "Reload file"), h("button", { type: "button", class: "linklike", onclick: () => save(build(), true) }, "Keep mine"));
    const merge = async () => { const target = prompt(`Merge ${sel.name} into which mode? (${live.filter((m) => m.name !== sel.name).map((m) => m.name).join(", ")})`); if (!target || !modes.some((m) => m.name === target)) return; await save(build({ retired: new Date().toISOString().slice(0, 10), merged_into: target })); };
    const retire = async () => { if (!confirm(`Retire ${sel.name}? Existing labels keep resolving; no new check may reference it.`)) return; await save(build({ retired: new Date().toISOString().slice(0, 10) })); };
    editor = h("section", { class: "card side", "aria-label": "Selected failure mode" },
      h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title mono", style: "font-size:16px" }, num(sel.name, "failure_mode", { mode: sel.name }, sel.name)), h("div", { class: "caption muted mono", style: "font-weight:400;font-size:12px" }, `evals/${sel.path}`), plain(sel.name, "failure_mode", { mode: sel.name })), sel.retired ? h("span", { class: "pill" }, `Retired${sel.merged_into ? ` into ${sel.merged_into}` : ""}`) : h("span", { class: `pill ${sel.severity === "high" ? "bad" : sel.severity === "med" ? "warn" : ""}` }, `${sel.severity} severity`)),
      ...fields,
      h("div", { class: "verdict" }, h("button", { type: "button", class: "btn primary", onclick: () => save(build()) }, "Save")),
      conflictRow,
      h("div", { class: "field" }, h("span", {}, "Linked"), h("div", { class: "linked" },
        h("span", {}, "Labeled traces"), h("a", { href: sel.label_traces.length ? `#/review/${encodeURIComponent(state.batches[0]?.name ?? "")}/${encodeURIComponent(sel.label_traces[0])}` : "#/review" }, `${sel.fail_labels} Fail / ${sel.labels} labels`),
        h("span", {}, "Grader"), h("a", { href: sel.grader.href ?? "#/judges" }, sel.grader.label + (sel.grader.tpr !== undefined && sel.grader.tpr !== null && !Number.isNaN(sel.grader.tpr) ? ` · TPR ${sel.grader.tpr} / TNR ${sel.grader.tnr}` : "")))),
      h("div", { class: "field" }, h("span", {}, "Where it shows up"),
        sel.tasks.length ? h("ul", { class: "where" }, ...sel.tasks.map((t) => h("li", { class: t.latest?.failed ? "fail" : "" },
          h("div", { class: "where-head" }, h("a", { class: "mono", href: `#/tasks/${encodeURIComponent(t.suite)}/${encodeURIComponent(t.id)}` }, t.id),
            t.latest ? h("span", { class: `pill ${t.latest.failed ? "bad" : "good"}` }, t.latest.failed ? `Failing ${t.latest.failed} of ${t.latest.trials}` : "Passing") : h("span", { class: "pill" }, "Not run")),
          t.description ? h("p", { class: "desc" }, t.description) : null,
          h("p", { class: "caption muted" }, `${t.suite} suite · check `, h("span", { class: "mono" }, t.check), ` (${t.type})`, t.source ? ` · from ${t.source}` : "",
            t.expect ? h("span", { class: "mono expect" }, " expects " + Object.entries(t.expect).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")) : null,
            t.fn ? h("span", { class: "mono expect" }, ` ${t.fn}`) : null),
          t.latest?.why ? h("p", { class: "why" }, h("strong", {}, "Why it failed: "), t.latest.why.claude ?? t.latest.why.headline) : null,
          t.latest?.transcript ? h("a", { href: t.latest.transcript }, `See what happened in ${t.latest.run_id} →`) : null)))
        : h("p", { class: "caption muted", style: "margin:0" }, "No task checks this mode yet. Add a check with failure_mode: " + sel.name + " to a task.")),
      sel.example_note ? h("div", { class: "field" }, h("span", {}, "Example from your notes"), h("div", { class: "quote" }, `“${sel.example_note}”`)) : null,
      h("div", { class: "row-actions" }, h("button", { type: "button", class: "linklike", onclick: merge }, "Merge into…"), h("button", { type: "button", class: "linklike danger", onclick: retire, disabled: Boolean(sel.retired) }, sel.retired ? "Retired" : "Retire")));
  }
  const create = async () => {
    const name = prompt("Name for the new failure mode (snake_case):"); if (!name) return;
    const data = { name, definition: "Describe the failure in plain words: what Fail looks like, what Pass looks like.", severity: "med", created: new Date().toISOString().slice(0, 10) };
    try { await api("/api/file", { method: "PUT", body: JSON.stringify({ path: `failure_modes/${name}.yaml`, data }) }); await refreshHealth(); location.hash = `#/modes/${encodeURIComponent(name)}`; if (location.hash.endsWith(encodeURIComponent(name))) renderModes(name); }
    catch (e) { alert(`Not created: ${e.body?.problems?.[0]?.message ?? e.message}`); }
  };
  page.replaceChildren(h("div", { class: "column" },
    h("header", { class: "page-header" }, h("div", { class: "titles" }, h("h1", { class: "t-page-title" }, "Failure modes"), h("p", { class: "subtitle" }, `${live.length} named problems from ${modes.reduce((a, m) => a + m.labels, 0)} labels · each one is a file in `, h("span", { class: "mono" }, "evals/failure_modes/"))),
      h("div", { class: "verdict" }, h("a", { href: `#/discover/${encodeURIComponent(state.batches[0]?.name ?? "")}`, class: "btn" }, "Ask Claude to regroup from new notes"), h("button", { type: "button", class: "btn primary", onclick: create }, "New failure mode"))),
    h("div", { class: "two-col" }, pareto, editor)));
}
