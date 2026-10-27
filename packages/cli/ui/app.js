// litmustest dashboard. Vanilla ES module, no build step. Routes: #/review[/<batch>[/<trace>]], #/pending, others placeholders.
const $ = (sel, el = document) => el.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v; else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else if (k === "html") el.innerHTML = v; else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};
const api = async (path, init) => {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.message ?? r.statusText), { status: r.status, body });
  return body;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const short = (v, n = 160) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const fmtArgs = (a) => a && typeof a === "object" ? Object.entries(a).filter(([k]) => !k.startsWith("_")).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ") : "";
const ago = (iso) => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

const state = { health: null, modes: [], batches: [], route: [], seq: 0 };
/** A render that started before a later navigation must not replace the page. */
const stale = (seq) => seq !== state.seq;

const NAV = [
  ["Overview", "#/overview", "soon"], ["Review queue", "#/review"], ["Failure modes", "#/modes", "soon"], ["Tasks & suites", "#/tasks", "soon"],
  ["Run compare", "#/compare", "soon"], ["Transcripts", "#/transcripts", "soon"], ["Judges", "#/judges", "soon"], ["Settings", "#/settings", "soon"],
];
function renderNav() {
  const cur = "#/" + (state.route[0] ?? "review");
  const items = $("#nav-items"); items.replaceChildren();
  for (const [label, href, soon] of NAV) {
    const a = h("a", { class: `nav-item${soon ? " soon" : ""}`, href, "aria-current": href === cur ? "page" : undefined }, h("span", {}, label));
    if (label === "Review queue" && state.batches.length) { const b = state.batches[0]; const left = b.items - b.labelled; if (left > 0) a.append(h("span", { class: "count", title: `${left} to review` }, String(left))); }
    if (label === "Judges" && state.modes.some((m) => m.status === "stale")) a.append(h("span", { class: "pill warn" }, `${state.modes.filter((m) => m.status === "stale").length} stale`));
    items.append(a);
  }
  const tray = $("#tray"); const n = state.health?.pending ?? 0;
  tray.hidden = n === 0 && !state.route[0]?.startsWith("pending");
  $("#tray-count").textContent = String(n); $("#tray-branch").textContent = state.health?.branch ?? "";
  $("#brand-sub").textContent = state.health?.project ? `${state.health.project.replace(/_/g, "-")} · ${state.health.branch}` : "";
}

async function refreshHealth() { state.health = await api("/api/health"); state.batches = (await api("/api/batches")).batches; state.modes = (await api("/api/failure_modes")).failure_modes; renderNav(); }

// ---------------- review queue
const review = { batch: null, traceId: null, trace: null, verdict: null, chips: new Set(), saving: false, status: "", annotator: localStorage.getItem("litmustest.annotator") || "" };

async function renderReview(batchName, traceId) {
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
    h("div", { class: "field" }, h("span", {}, "Failure modes ", h("span", { class: "faint" }, "(dashed = suggested from your note; toggle to confirm)")), chipsEl),
    h("div", { class: "save-row" }, saveBtn, annotatorInput, h("a", { href: "#/tasks", class: "faint", style: "font-size:13px" }, "Promote to regression task"), statusEl));

  // side panels
  const soFar = h("section", { class: "card", "aria-label": "Failure modes so far" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Failure modes so far"), h("span", { class: "caption" }, `from ${labelled.size} labeled traces`)),
    ...(state.modes.length ? state.modes.map((m) => h("div", { class: "mode-row" }, h("div", { class: "top" }, h("span", { class: "mono" }, m.name), h("span", { class: `pill ${m.status === "trusted" ? "good" : m.status === "stale" ? "warn" : m.grader === "Judge" ? "warn" : ""}` }, m.grader === "Judge" ? (m.status === "trusted" ? "Trusted judge" : m.status === "stale" ? "Stale judge" : "Judge, untested") : m.grader === "Code check" ? "Has check" : "No grader")), h("span", { class: "def" }, m.definition), h("span", { class: "meta" }, `${m.fail_labels} Fail labels · severity ${m.severity}`))) : [h("p", { class: "muted", style: "margin:0" }, "No failure modes yet. Label a few traces, then ask Claude to regroup your notes.")]),
    h("div", { class: "list-links" }, h("a", { href: "#/modes", "aria-disabled": "true", class: "faint" }, "Ask Claude to regroup notes"), h("a", { href: "#/judges", "aria-disabled": "true", class: "faint" }, "Draft judge from labels")));
  const coverage = h("section", { class: "card", "aria-label": "Coverage" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Coverage by cluster"), h("span", { class: "caption" }, "reviewed / in batch")),
    ...b.coverage.clusters.map((c) => { const inBatch = items.filter((i) => i.cluster === c.id); const done = inBatch.filter((i) => labelled.has(i.trace_id)).length; return h("div", { class: `cluster-row${c.id === item.cluster ? " active" : ""}` }, h("span", { class: "terms", title: `${c.size} traces: ${c.terms.join(", ")}` }, c.terms.slice(0, 3).join(", ")), h("div", { class: "bar" }, h("span", { style: `width:${inBatch.length ? (100 * done) / inBatch.length : 0}%` })), h("span", { class: "frac" }, `${done}/${inBatch.length}`)); }));
  const strip = h("div", { class: "strip", role: "group", "aria-label": "Traces in batch" }, ...items.map((i, j) => h("button", { type: "button", class: labelled.has(i.trace_id) ? "labelled" : "", "aria-current": j === ix ? "true" : undefined, title: i.trace_id, onclick: () => nav(j - ix) }, String(j + 1))));

  page.replaceChildren(h("div", { class: "column" }, head, progress, h("div", { class: "two-col" }, card, h("div", { class: "side" }, soFar, coverage, h("section", { class: "card", "aria-label": "Batch" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Batch"), h("span", { class: "caption" }, "green = labeled")), strip)))));
  if (!document.activeElement || document.activeElement === document.body) card.focus({ preventScroll: true });

  function rerender() { renderReview(name, item.trace_id); }
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
function step(time, dotClass, body) { return h("li", { class: "step" }, h("span", { class: "time" }, time), h("div", { class: "rail", "aria-hidden": "true" }, h("span", { class: `dot ${dotClass}` }), h("span", { class: "line" })), h("div", { class: "step-body" }, ...body)); }
function header(title, sub) { return h("header", { class: "page-header" }, h("div", { class: "titles" }, h("h1", { class: "t-page-title" }, title), sub && h("p", { class: "subtitle" }, sub))); }

// ---------------- pending changes
async function renderPending() {
  const seq = state.seq;
  const p = await api("/api/pending");
  if (stale(seq)) return;
  const page = $("#page");
  const file = (f) => h("div", { class: "pending-file" }, h("div", { class: "row" }, h("span", { class: "mono" }, f.path.replace(/^.*?evals\//, "")), h("span", { class: `pill ${f.status === "added" ? "good" : f.status === "deleted" ? "bad" : "blue"}` }, f.status), h("span", { class: "caption muted" }, f.affected_views.join(", ") || "", ` · ${ago(f.written_at)}`)), h("pre", { class: "code-block", html: f.diff.split("\n").map((l) => `<span class="${l.startsWith("+") && !l.startsWith("+++") ? "diff-add" : l.startsWith("-") && !l.startsWith("---") ? "diff-del" : l.startsWith("@@") ? "diff-hunk" : ""}">${esc(l)}</span>`).join("\n") }));
  const msg = h("input", { class: "text", placeholder: "Commit message (optional)", "aria-label": "Commit message", style: "flex:1 1 260px" });
  const status = h("span", { class: "status", "aria-live": "polite" });
  const act = async (path, body, label) => { try { const r = await api(path, { method: "POST", body: JSON.stringify(body) }); status.textContent = label(r); await refreshHealth(); await renderPending(); } catch (e) { status.textContent = `${e.message}${e.body?.command ? ` · run: ${e.body.command}` : ""}`; status.className = "status bad"; } };
  page.replaceChildren(h("div", { class: "column" }, header("Pending changes", h("span", {}, "On branch ", h("span", { class: "mono" }, p.branch), ". Every save from the dashboard lands here as a diff; nothing reaches git until you commit.")),
    h("section", { class: "card", "aria-label": "Changes" }, ...(p.files.length ? p.files.map(file) : [h("p", { class: "muted", style: "margin:0" }, "Nothing pending.")])),
    h("div", { class: "save-row" }, msg, h("button", { type: "button", class: "btn primary", disabled: !p.files.length, onclick: () => act("/api/pending/commit", { message: msg.value || undefined }, (r) => `Committed ${r.commit} on ${r.branch}`) }, "Commit to branch"), h("button", { type: "button", class: "btn", disabled: Boolean(p.files.length) || !p.branch.startsWith("evals/"), onclick: () => act("/api/pending/pr", {}, (r) => `Opened ${r.url}`) }, "Open PR"), h("button", { type: "button", class: "btn", style: "color:var(--bad)", disabled: !p.files.length, onclick: () => { if (confirm("Discard every pending change? This reverts the files on disk.")) act("/api/pending/discard", {}, (r) => `Discarded ${r.discarded.length} files`); } }, "Discard"), status)));
}

function renderSoon(title) { $("#page").replaceChildren(h("div", { class: "column" }, header(title), h("div", { class: "empty" }, `${title} arrives with a later step of Phase 1; see docs/SPEC.md. The data it will show is already in the evals/ directory.`))); }

// ---------------- router
async function render() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  state.route = parts.length ? parts : ["review"];
  state.seq++;
  renderNav();
  document.removeEventListener("keydown", keyHandler); review.keys = null;
  try {
    switch (state.route[0]) {
      case "review": await renderReview(state.route[1], state.route[2]); document.addEventListener("keydown", keyHandler); break;
      case "pending": await renderPending(); break;
      default: renderSoon(NAV.find(([, href]) => href === "#/" + state.route[0])?.[0] ?? "Not found");
    }
  } catch (e) { $("#page").replaceChildren(h("div", { class: "column" }, header("Something went wrong"), h("div", { class: "empty" }, e.message))); }
}
function keyHandler(e) { if (e.metaKey && e.key !== "Enter") return; review.keys?.(e); }
window.addEventListener("hashchange", render);
const events = new EventSource("/api/events");
for (const t of ["saved", "label", "committed", "discarded", "changed"]) events.addEventListener(t, () => { refreshHealth().catch(() => {}); if (t !== "label" && state.route[0] === "pending") render(); });
refreshHealth().then(render).catch((e) => { $("#page").replaceChildren(h("div", { class: "column" }, header("Cannot reach the server"), h("div", { class: "empty" }, e.message))); });
