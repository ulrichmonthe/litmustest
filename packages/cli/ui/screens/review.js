// litmustest dashboard: screens/review.js
import { header, step } from "../components.js";
import { term } from "../explainer.js";
import { $, ago, api, fmtArgs, h, short } from "../lib/dom.js";
import { stale, state } from "../lib/state.js";
import { render } from "../router.js";
import { refreshHealth } from "../shell.js";

// ---------------- review queue
/** The task the last Promote wrote, so its editor can say what the drafted reference still needs. */
export const review = { batch: null, traceId: null, trace: null, verdict: null, chips: new Set(), saving: false, status: "", annotator: localStorage.getItem("litmustest.annotator") || "" };

export async function renderReview(batchName, traceId) {
  const page = $("#page"); const seq = state.seq;
  if (!state.batches.length) { page.replaceChildren(h("div", { class: "column" }, header("Review queue", "No batch yet."), h("div", { class: "empty" }, "Run ", h("code", { class: "mono" }, "litmustest ingest <traces.jsonl>"), " to sample a review batch, then reload."))); return; }
  const name = batchName ?? state.batches[0].name;
  if (!review.batch || review.batch.name !== name) review.batch = await api(`/api/batches/${encodeURIComponent(name)}`);
  const b = review.batch;
  const items = b.items;
  const labelled = new Set(items.filter((i) => i.labels.length).map((i) => i.trace_id));
  const ix = Math.max(0, traceId ? items.findIndex((i) => i.trace_id === traceId) : items.findIndex((i) => !labelled.has(i.trace_id)));
  const item = items[ix] ?? items[0];
  if (!item) return;
  if (review.traceId !== item.trace_id) { review.traceId = item.trace_id; review.trace = await api(`/api/traces/${encodeURIComponent(item.trace_id)}`); review.verdict = null; review.chips = new Set(); review.status = ""; }
  if (stale(seq)) return;
  if (!review.annotator) review.annotator = state.health?.annotator || "";
  const t = review.trace; const v = t.view;
  const nav = (d) => { const j = ix + d; if (j >= 0 && j < items.length) location.hash = `#/review/${encodeURIComponent(name)}/${encodeURIComponent(items[j].trace_id)}`; };
  const existing = item.labels.find((l) => l.failure_mode === "overall");

  // header
  const batchSelect = h("select", { class: "select", "aria-label": "Batch", onchange: (e) => { location.hash = `#/review/${encodeURIComponent(e.target.value)}`; } }, ...state.batches.map((x) => h("option", { value: x.name, selected: x.name === name }, `${x.name} · ${x.items} traces`)));
  const head = h("header", { class: "page-header" },
    h("div", { class: "titles" },
      h("div", { class: "title-row" }, h("h1", { class: "t-page-title" }, "Review queue"), batchSelect),
      h("p", { class: "subtitle" }, `Batch ${b.name}: ${b.coverage.total_traces} traces from `, h("span", { class: "mono" }, b.source), ` · ${b.coverage.clusters.length} clusters + ${items.filter((i) => i.reason === "random").length} random · labels save to `, h("span", { class: "mono" }, `labels/${b.name}.jsonl`))),
    h("div", { class: "kbd-legend", "aria-label": "Keyboard shortcuts" }, h("kbd", {}, "j"), h("kbd", {}, "k"), h("span", {}, "move"), h("kbd", {}, "p"), h("kbd", {}, "f"), h("span", {}, "pass / fail"), h("kbd", {}, "n"), h("span", {}, "note"), h("kbd", {}, "↵"), h("span", {}, "save")));
  const progress = h("div", { class: "progress" }, h("div", { class: "bar", role: "progressbar", "aria-valuenow": labelled.size, "aria-valuemax": items.length, "aria-label": "Traces labelled" }, h("span", { style: `width:${(100 * labelled.size) / items.length}%` })), h("span", { class: "caption muted num" }, `Trace ${ix + 1} of ${items.length} · ${labelled.size} labeled`));

  // trace card
  const missing = (t.expected_tools ?? []).filter((n) => !v.calls.some((c) => c.name === n));
  const steps = []; let turn = 0; let stepNo = 0;
  for (const s of v.turns) {
    stepNo++;
    const time = `${(stepNo * 0.9).toFixed(1)}s`;
    if (s.role === "user" || s.role === "system") { turn++; steps.push(step(time, "", [h("div", { class: "step-head" }, h("span", { class: "eyebrow" }, s.role === "user" ? "Customer" : "System"), h("span", { class: "faint", style: "font-size:12px" }, `Turn ${turn}`)), h("p", { class: "bubble customer" }, s.content)])); }
    else if (s.role === "agent") steps.push(step(time, "agent", [h("div", { class: "step-head" }, h("span", { class: "eyebrow" }, "Agent"), h("span", { class: "faint", style: "font-size:12px" }, `Turn ${turn}`)), h("p", { class: "bubble agent" }, s.content)]));
    else { const call = v.calls.find((c) => c.span_id === s.span_id) ?? { name: s.tool, args: {}, result: s.content, ok: true }; steps.push(step(time, "", [h("div", { class: "step-head" }, h("span", { class: "eyebrow" }, "Tool"), h("span", { class: "mono" }, call.name), !call.ok && h("span", { class: "pill bad" }, "Error")), h("pre", { class: `code-block${call.ok ? "" : " bad"}` }, `${call.name}(${fmtArgs(call.args)})\n`, h("span", { class: call.ok ? "result" : "error" }, `→ ${short(call.result ?? "")}`))])); }
  }
  for (const m of missing) steps.push(step("", "missing", [h("div", { class: "step-head" }, h("span", { class: "eyebrow bad" }, "Expected"), h("span", { class: "mono" }, m), h("span", { class: "pill bad" }, "Never called")), h("p", { class: "caption muted", style: "margin:0;font-size:13px" }, "A task promoted from this trace requires this tool.")]));
  const meta = [t.trace.metadata?.scenario && String(t.trace.metadata.scenario).replace(/_/g, " "), t.trace.metadata?.persona && `${t.trace.metadata.persona} persona`, `${v.turns.filter((x) => x.role !== "tool").length} turns`, `${v.calls.length} tool calls`, v.model].filter(Boolean).join(" · ");

  const verdictBtn = (val, label, key, cls) => h("button", { type: "button", class: `btn ${cls}`, "aria-pressed": review.verdict === val ? "true" : "false", onclick: () => { review.verdict = val; rerender(); } }, label, key && h("kbd", {}, key));
  const note = h("textarea", { class: "note", id: "note", rows: 3, placeholder: "The first thing that looks wrong, in your words", "aria-label": "Note", oninput: (e) => { review.note = e.target.value; updateChips(); } }, review.note ?? "");
  const suggested = () => { const text = (review.note ?? "").toLowerCase(); return new Set(state.modes.filter((m) => m.name.split("_").some((w) => w.length > 3 && text.includes(w))).map((m) => m.name)); };
  const chipsEl = h("div", { class: "chips", role: "group", "aria-label": "Failure modes" });
  const updateChips = () => { const sug = suggested(); chipsEl.replaceChildren(...state.modes.map((m) => h("button", { type: "button", class: `chip${sug.has(m.name) ? " suggested" : ""}`, "aria-pressed": review.chips.has(m.name) ? "true" : "false", title: m.definition, onclick: () => { review.chips.has(m.name) ? review.chips.delete(m.name) : review.chips.add(m.name); updateChips(); } }, review.chips.has(m.name) ? "✓ " : "", m.name)), h("a", { class: "chip", href: "#/modes", style: "border-style:dashed" }, "+ new mode")); };
  updateChips();
  const statusEl = h("span", { class: `status${review.status.startsWith("Saved") ? " good" : review.status.startsWith("Not") ? " bad" : ""}`, "aria-live": "polite" }, review.status || (existing ? `Labeled ${existing.label} by ${existing.annotator} · ${ago(existing.at)}` : `annotator: ${review.annotator || "set your name"}`));
  const annotatorInput = h("input", { class: "text", id: "annotator", placeholder: "annotator", "aria-label": "Annotator", value: review.annotator, style: "max-width:180px", oninput: (e) => { review.annotator = e.target.value; localStorage.setItem("litmustest.annotator", e.target.value); } });
  const saveBtn = h("button", { type: "button", class: "btn primary", id: "save", disabled: review.saving, onclick: () => save() }, "Save and next", h("kbd", {}, "↵"));
  const card = h("section", { class: "card main", "aria-label": "Trace", tabindex: "0", id: "trace-card" },
    h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title mono", style: "font-size:16px" }, item.trace_id), h("div", { class: "caption muted" }, meta, " · cluster ", String(item.cluster), item.reason === "representative" ? " representative" : "")), h("a", { href: `/api/traces/${encodeURIComponent(item.trace_id)}`, target: "_blank", rel: "noopener" }, "Raw JSON")),
    h("ol", { class: "timeline" }, ...steps),
    h("div", { class: "verdict", role: "group", "aria-label": "Verdict" }, verdictBtn("Pass", "Pass", "p", "pass"), verdictBtn("Fail", "Fail", "f", "fail"), verdictBtn("Skip", "Skip", "", "skip")),
    h("label", { class: "field" }, h("span", {}, "Note: the first thing that looks wrong, in your words"), note),
    h("div", { class: "field" }, h("span", {}, term("failure_mode", "Failure modes"), " ", h("span", { class: "faint" }, "(dashed = suggested from your note; toggle to confirm)")), chipsEl),
    h("div", { class: "save-row" }, saveBtn, annotatorInput, h("button", { type: "button", class: "btn", id: "promote", title: "Write a task, a reference solution drafted from this trace and the suite entry, as one pending change", onclick: () => promote() }, "Promote to regression task"), statusEl));

  // side panels
  const soFar = h("section", { class: "card", "aria-label": "Failure modes so far" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Failure modes so far"), h("span", { class: "caption" }, `from ${labelled.size} labeled traces`)),
    ...(state.modes.length ? state.modes.map((m) => h("div", { class: "mode-row" }, h("div", { class: "top" }, h("span", { class: "mono" }, m.name), h("span", { class: `pill ${m.status === "trusted" ? "good" : m.status === "stale" ? "warn" : m.grader === "Judge" ? "warn" : ""}` }, m.grader === "Judge" ? (m.status === "trusted" ? "Trusted judge" : m.status === "stale" ? "Stale judge" : "Judge, untested") : m.grader === "Code check" ? "Has check" : "No grader")), h("span", { class: "def" }, m.definition), h("span", { class: "meta" }, `${m.fail_labels} Fail labels · severity ${m.severity}`))) : [h("p", { class: "muted", style: "margin:0" }, "No failure modes yet. Label a few traces, then ask Claude to regroup your notes.")]),
    h("div", { class: "list-links" }, h("a", { href: `#/discover/${encodeURIComponent(b.name)}` }, "Ask Claude to regroup notes"), h("a", { href: "#/judges", "aria-disabled": "true", class: "faint" }, "Draft judge from labels")));
  const coverage = h("section", { class: "card", "aria-label": "Coverage" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Coverage by cluster"), h("span", { class: "caption" }, "reviewed / in batch")),
    ...b.coverage.clusters.map((c) => { const inBatch = items.filter((i) => i.cluster === c.id); const done = inBatch.filter((i) => labelled.has(i.trace_id)).length; return h("div", { class: `cluster-row${c.id === item.cluster ? " active" : ""}` }, h("span", { class: "terms", title: `${c.size} traces: ${c.terms.join(", ")}` }, c.terms.slice(0, 3).join(", ")), h("div", { class: "bar" }, h("span", { style: `width:${inBatch.length ? (100 * done) / inBatch.length : 0}%` })), h("span", { class: "frac" }, `${done}/${inBatch.length}`)); }));
  const strip = h("div", { class: "strip", role: "group", "aria-label": "Traces in batch" }, ...items.map((i, j) => h("button", { type: "button", class: labelled.has(i.trace_id) ? "labelled" : "", "aria-current": j === ix ? "true" : undefined, title: i.trace_id, onclick: () => nav(j - ix) }, String(j + 1))));

  page.replaceChildren(h("div", { class: "column" }, head, progress, h("div", { class: "two-col" }, card, h("div", { class: "side" }, soFar, coverage, h("section", { class: "card", "aria-label": "Batch" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Batch"), h("span", { class: "caption" }, "green = labeled")), strip)))));
  if (!document.activeElement || document.activeElement === document.body) card.focus({ preventScroll: true });

  function rerender() { renderReview(name, item.trace_id); }
  async function promote() {
    try {
      const r = await api(`/api/traces/${encodeURIComponent(item.trace_id)}/promote`, { method: "POST", body: JSON.stringify({ suite: "regression" }) });
      state.promoted = { task: r.task, from: item.trace_id, problems: r.reference_problems ?? [], ungraded: r.ungraded_modes ?? [] };
      await refreshHealth(); location.hash = r.href;
    } catch (e) { review.status = `Not promoted · ${e.body?.problems?.[0]?.message ?? e.message}`; rerender(); }
  }
  async function save() {
    if (review.saving) return;
    if (!review.verdict) { review.status = "Not saved · pick Pass, Fail or Skip"; rerender(); return; }
    if (!review.annotator) { review.status = "Not saved · set your annotator name"; rerender(); $("#annotator")?.focus(); return; }
    review.saving = true; rerender();
    try {
      const base = { batch: b.name, trace_id: item.trace_id, annotator: review.annotator, note: review.note || undefined };
      const posted = [await api("/api/labels", { method: "POST", body: JSON.stringify({ ...base, failure_mode: "overall", label: review.verdict }) })];
      for (const m of review.chips) posted.push(await api("/api/labels", { method: "POST", body: JSON.stringify({ ...base, failure_mode: m, label: "Fail" }) }));
      review.status = `Saved ${posted.length} label${posted.length > 1 ? "s" : ""} · ${posted[0].label.at}`;
      review.batch = null; review.note = ""; review.verdict = null; review.chips = new Set();
      await refreshHealth();
      const next = items.slice(ix + 1).find((i) => !i.labels.length) ?? items.slice(0, ix).find((i) => !i.labels.length);
      location.hash = next ? `#/review/${encodeURIComponent(b.name)}/${encodeURIComponent(next.trace_id)}` : `#/review/${encodeURIComponent(b.name)}/${encodeURIComponent(item.trace_id)}`;
      if (!next) { review.status = "Saved · every trace in this batch is labeled"; render(); }
    } catch (e) { review.status = `Not saved · ${e.body?.problems?.[0]?.message ?? e.message}`; review.saving = false; rerender(); return; }
    review.saving = false;
  }
  review.keys = (e) => {
    const inField = ["TEXTAREA", "INPUT", "SELECT"].includes(e.target.tagName);
    if (e.key === "Enter" && (!inField || e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); return; }
    if (inField) return;
    if (e.key === "j") { e.preventDefault(); nav(1); } else if (e.key === "k") { e.preventDefault(); nav(-1); }
    else if (e.key === "p") { e.preventDefault(); review.verdict = "Pass"; rerender(); } else if (e.key === "f") { e.preventDefault(); review.verdict = "Fail"; rerender(); }
    else if (e.key === "s") { e.preventDefault(); review.verdict = "Skip"; rerender(); }
    else if (e.key === "n") { e.preventDefault(); $("#note")?.focus(); }
    else if (e.key === "Escape") { $("#trace-card")?.focus(); }
  };
}
