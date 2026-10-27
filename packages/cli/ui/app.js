// litmustest dashboard. Vanilla ES module, no build step. Routes: #/review[/<batch>[/<trace>]], #/pending, others placeholders.
const $ = (sel, el = document) => el.querySelector(sel);
const SVG_TAGS = new Set(["svg", "path", "circle", "line", "text", "rect", "g"]);
const h = (tag, attrs = {}, ...children) => {
  const el = SVG_TAGS.has(tag) ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.setAttribute("class", v); else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else if (k === "html") el.innerHTML = v; else el.setAttribute(k, v === true ? "" : v);
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
  ["Overview", "#/overview"], ["Review queue", "#/review"], ["Failure modes", "#/modes"], ["Tasks & suites", "#/tasks", "soon"],
  ["Run compare", "#/compare", "soon"], ["Transcripts", "#/transcripts", "soon"], ["Judges", "#/judges"], ["Settings", "#/settings", "soon"],
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
    h("div", { class: "list-links" }, h("a", { href: `#/discover/${encodeURIComponent(b.name)}` }, "Ask Claude to regroup notes"), h("a", { href: "#/judges", "aria-disabled": "true", class: "faint" }, "Draft judge from labels")));
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

// ---------------- discover: proposed failure modes from notes
const disc = { result: null, batch: null, chosen: new Set(), busy: false, error: "" };
async function renderDiscover(batchName) {
  const seq = state.seq; const page = $("#page");
  const run = async () => { disc.busy = true; disc.error = ""; disc.result = null; draw(); try { disc.result = await api("/api/discover", { method: "POST", body: JSON.stringify({ batch: batchName || undefined }) }); disc.chosen = new Set(disc.result.proposals.map((p) => p.path)); } catch (e) { disc.error = e.message; } disc.busy = false; if (!stale(seq)) draw(); };
  const draw = () => {
    const r = disc.result;
    const list = r ? r.proposals.map((p) => h("div", { class: "pending-file" }, h("label", { class: "row", style: "cursor:pointer" }, h("input", { type: "checkbox", checked: disc.chosen.has(p.path), style: "width:20px;height:20px", onchange: (e) => { e.target.checked ? disc.chosen.add(p.path) : disc.chosen.delete(p.path); } }), h("span", { class: "mono" }, p.name), h("span", { class: `pill ${p.action === "create" ? "good" : p.action === "retire" ? "bad" : "blue"}` }, p.action), h("span", { class: `pill ${p.severity === "high" ? "bad" : p.severity === "med" ? "warn" : ""}` }, `severity ${p.severity}`), h("span", { class: "caption muted" }, `${p.examples.length} example traces`)), h("p", { class: "subtitle", style: "font-size:13px;color:var(--ink)" }, p.rationale), h("pre", { class: "code-block", html: p.diff.split("\n").map((l) => `<span class="${l.startsWith("+") && !l.startsWith("+++") ? "diff-add" : l.startsWith("-") && !l.startsWith("---") ? "diff-del" : l.startsWith("@@") ? "diff-hunk" : ""}">${esc(l)}</span>`).join("\n") }))) : [];
    const status = h("span", { class: "status", "aria-live": "polite" });
    const accept = async () => {
      const picked = r.proposals.filter((p) => disc.chosen.has(p.path)); let ok = 0; const fails = [];
      for (const p of picked) { try { await api("/api/file", { method: "PUT", body: JSON.stringify({ path: p.path, content: p.content }) }); ok++; } catch (e) { fails.push(`${p.name}: ${e.body?.problems?.[0]?.message ?? e.message}`); } }
      await refreshHealth();
      status.textContent = `${ok} file${ok === 1 ? "" : "s"} saved to the Pending changes tray${fails.length ? `; refused: ${fails.join("; ")}` : ""}`; status.className = fails.length ? "status bad" : "status good";
      disc.result = { ...r, proposals: r.proposals.filter((p) => !disc.chosen.has(p.path) || fails.some((f) => f.startsWith(p.name + ":"))) }; draw();
    };
    page.replaceChildren(h("div", { class: "column" },
      h("header", { class: "page-header" }, h("div", { class: "titles" }, h("nav", { class: "breadcrumb", "aria-label": "Breadcrumb" }, h("a", { href: `#/review/${encodeURIComponent(batchName ?? "")}` }, "Review queue"), h("span", { class: "sep" }, "/"), h("span", {}, "Regroup notes")), h("h1", { class: "t-page-title" }, "Proposed failure modes"), h("p", { class: "subtitle" }, "Claude read the reviewers' notes", batchName ? [" from batch ", h("span", { class: "mono" }, batchName)] : "", " and grouped them. Nothing is written until you accept; accepted files land in the Pending changes tray as a diff for you to commit.")),
        h("div", { class: "verdict" }, h("button", { type: "button", class: "btn", disabled: disc.busy, onclick: run }, disc.result ? "Regroup again" : "Regroup notes"))),
      disc.busy ? h("div", { class: "empty" }, "Grouping notes with the model… this takes half a minute.") : disc.error ? h("div", { class: "empty", style: "color:var(--bad)" }, disc.error) : r ? [
        h("p", { class: "subtitle" }, `${r.proposals.length} proposed file${r.proposals.length === 1 ? "" : "s"} from ${r.notes_used} notes on ${r.traces_used} traces · model `, h("span", { class: "mono" }, r.model), r.unassigned.length ? ` · ${r.unassigned.length} notes fit no mode: ${r.unassigned.slice(0, 6).join(", ")}${r.unassigned.length > 6 ? "…" : ""}` : ""),
        h("section", { class: "card", "aria-label": "Proposals" }, ...(list.length ? list : [h("p", { class: "muted", style: "margin:0" }, "Nothing to change: the existing failure modes already cover every note.")])),
        h("div", { class: "save-row" }, h("button", { type: "button", class: "btn primary", disabled: !list.length, onclick: accept }, "Accept selected"), h("a", { href: "#/pending" }, "Open Pending changes"), status),
      ] : h("div", { class: "empty" }, "Press Regroup notes to start.")));
  };
  if (!disc.result || disc.batch !== batchName) { disc.batch = batchName; await run(); } else draw();
}

// ---------------- failure modes
const modesPage = { sel: null, draft: null, state: "", stateClass: "", hash: null };
function spark(values, w = 64, hgt = 20) {
  if (!values.length) return "";
  const max = Math.max(1, ...values); const step = values.length > 1 ? (w - 4) / (values.length - 1) : 0;
  return values.map((v, i) => `${i ? "L" : "M"}${(2 + i * step).toFixed(1)} ${(hgt - 2 - ((hgt - 4) * v) / max).toFixed(1)}`).join(" ");
}
async function renderModes(selName) {
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
    h("div", { class: "pareto-head" }, h("span", {}, "Mode"), h("span"), h("span", { style: "text-align:right" }, "Fails"), h("span", {}, "Severity"), h("span", {}, "Grader"), h("span", { style: "text-align:right" }, "Trend")),
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
    const fields = [h("label", { class: `field ${modesPage.stateClass}` }, h("span", { class: "label-row" }, h("span", {}, "Definition"), stateEl), defEl), h("label", { class: `field ${modesPage.stateClass}` }, h("span", {}, "Severity"), sevEl), h("label", { class: `field ${modesPage.stateClass}` }, h("span", {}, "Owner"), ownerEl)];
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
      h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title mono", style: "font-size:16px" }, sel.name), h("div", { class: "caption muted mono", style: "font-weight:400;font-size:12px" }, `evals/${sel.path}`)), sel.retired ? h("span", { class: "pill" }, `Retired${sel.merged_into ? ` into ${sel.merged_into}` : ""}`) : h("span", { class: `pill ${sel.severity === "high" ? "bad" : sel.severity === "med" ? "warn" : ""}` }, `${sel.severity} severity`)),
      ...fields,
      h("div", { class: "verdict" }, h("button", { type: "button", class: "btn primary", onclick: () => save(build()) }, "Save")),
      conflictRow,
      h("div", { class: "field" }, h("span", {}, "Linked"), h("div", { class: "linked" },
        h("span", {}, "Labeled traces"), h("a", { href: sel.label_traces.length ? `#/review/${encodeURIComponent(state.batches[0]?.name ?? "")}/${encodeURIComponent(sel.label_traces[0])}` : "#/review" }, `${sel.fail_labels} Fail / ${sel.labels} labels`),
        h("span", {}, "Tasks with this check"), h("a", { href: "#/tasks" }, sel.tasks.length ? `${sel.tasks.length} task${sel.tasks.length > 1 ? "s" : ""} · ${[...new Set(sel.tasks.map((t) => t.suite))].join(", ")}` : "none yet"),
        h("span", {}, "Grader"), h("a", { href: sel.grader.href ?? "#/judges" }, sel.grader.label + (sel.grader.tpr !== undefined && sel.grader.tpr !== null && !Number.isNaN(sel.grader.tpr) ? ` · TPR ${sel.grader.tpr} / TNR ${sel.grader.tnr}` : "")))),
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

// ---------------- judges
async function renderJudges() {
  const seq = state.seq; const page = $("#page");
  const d = await api("/api/judges"); if (stale(seq)) return;
  const pill = (s) => h("span", { class: `pill ${s === "trusted" ? "good" : s === "stale" || s === "dev" ? "warn" : ""}` }, s === "trusted" ? "Trusted" : s === "stale" ? "Stale" : s === "dev" ? "Dev" : "Untested");
  const rows = d.judges.map((j) => h("tr", {}, h("td", {}, h("a", { class: "mono", href: `#/judges/${encodeURIComponent(j.name)}` }, j.name)), h("td", {}, pill(j.status)), h("td", { class: "num" }, j.dev ? `${j.dev.tpr} / ${j.dev.tnr}` : "—"), h("td", { class: "num" }, j.test ? `${j.test.tpr} / ${j.test.tnr}` : "—"), h("td", { class: "num" }, String(j.labels)), h("td", { class: "num" }, String(j.used_by)), h("td", { class: "mono", style: "font-weight:400;font-size:12px" }, `${j.model} · v${j.version}`)));
  const status = h("span", { class: "status", "aria-live": "polite" });
  const draft = async (mode, kind) => { status.textContent = `Drafting ${kind} for ${mode}…`; status.className = "status"; try { const r = await api(`/api/${kind === "judge" ? "judges" : "checks"}/${encodeURIComponent(mode)}/draft`, { method: "POST", body: "{}" }); status.textContent = `${r.files.length} files in the Pending changes tray${r.agreement ? ` · agreement ${r.agreement.agree}/${r.agreement.n}` : ""}`; status.className = "status good"; await refreshHealth(); if (kind === "judge") location.hash = `#/judges/${encodeURIComponent(mode)}`; else renderJudges(); } catch (e) { status.textContent = e.message; status.className = "status bad"; } };
  const cands = d.candidates.map((c) => h("div", { class: "alert" }, h("span", { class: "mono" }, c.name), h("span", { class: "body" }, h("span", {}, `${c.labels} labels${c.has_code_check ? " · has a code check" : ""}`)), h("div", { class: "verdict" }, h("button", { type: "button", class: "btn", disabled: c.labels < 6, title: c.labels < 6 ? "Needs at least 6 labels" : "", onclick: () => draft(c.name, "judge") }, "Draft judge from labels"), h("button", { type: "button", class: "btn", disabled: c.labels < 4, onclick: () => draft(c.name, "check") }, "Draft code check"))));
  page.replaceChildren(h("div", { class: "column" },
    h("header", { class: "page-header" }, h("div", { class: "titles" }, h("h1", { class: "t-page-title" }, "Judges"), h("p", { class: "subtitle" }, `One failure mode each · trusted at TPR and TNR ≥ ${d.threshold}% on a held-out test set, run once · ${d.judges.filter((j) => j.status === "trusted").length} of ${d.judges.length} trusted`)), status),
    h("section", { class: "card", "aria-label": "Judges" }, d.judges.length ? h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Judge"), h("th", { scope: "col" }, "Status"), h("th", { scope: "col", style: "text-align:right" }, "Dev TPR / TNR"), h("th", { scope: "col", style: "text-align:right" }, "Test TPR / TNR"), h("th", { scope: "col", style: "text-align:right" }, "Labels"), h("th", { scope: "col", style: "text-align:right" }, "Used by"), h("th", { scope: "col" }, "Model"))), h("tbody", {}, ...rows)) : h("p", { class: "muted", style: "margin:0" }, "No judges yet.")),
    h("section", { class: "card", "aria-label": "Failure modes without a judge" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Failure modes without a judge"), h("span", { class: "caption" }, "draft from labels; code checks first where a function can decide")), ...(cands.length ? cands : [h("p", { class: "muted", style: "margin:0" }, "Every failure mode has a judge.")]))));
}

const judgePage = { name: null, mode: "form", draft: null, hashes: null, state: "", cls: "", conflict: null };
async function renderJudge(name) {
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
  const drawShots = () => shotsEl.replaceChildren(...[...dr.few_shot.map((s, i) => h("div", { class: "shot" }, h("span", { class: `pill ${s.label === "Fail" ? "bad" : "good"}` }, s.label), h("a", { class: "mono", href: `#/review/${encodeURIComponent(state.batches[0]?.name ?? "")}/${encodeURIComponent(s.trace_id)}` }, s.trace_id), h("span", { class: "excerpt", title: s.note ?? "" }, s.note ?? "(no note)"), h("button", { type: "button", class: "linklike danger", style: "min-height:32px", onclick: () => { dr.few_shot.splice(i, 1); drawShots(); dirty(); } }, "Remove"))), dr.few_shot.length ? null : h("p", { class: "muted", style: "margin:0;font-size:13px" }, "No examples yet.")].filter(Boolean));
  drawShots();
  let pickerOpen = false; const pickerEl = h("div", {});
  const openPicker = async () => { pickerOpen = !pickerOpen; if (!pickerOpen) { pickerEl.replaceChildren(); return; } const t = await api(`/api/judges/${encodeURIComponent(name)}/train`); pickerEl.replaceChildren(h("div", { class: "card", style: "padding:12px;gap:4px" }, h("span", { class: "caption muted" }, `Train split · ${t.train.length} traces. Dev and test are never offered.`), ...t.train.filter((x) => !dr.few_shot.some((s) => s.trace_id === x.trace_id)).map((x) => h("div", { class: "shot" }, h("span", { class: `pill ${x.label === "Fail" ? "bad" : "good"}` }, x.label ?? "?"), h("span", { class: "mono" }, x.trace_id), h("span", { class: "excerpt", title: x.excerpt }, x.note ?? x.excerpt), h("button", { type: "button", class: "linklike", style: "min-height:32px", onclick: () => { dr.few_shot.push({ trace_id: x.trace_id, label: x.label, ...(x.note ? { note: x.note } : {}) }); drawShots(); dirty(); pickerOpen = false; pickerEl.replaceChildren(); } }, "Add"))))); };
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
  const kpi = (label, v, ci) => h("div", {}, h("span", {}, label), h("span", { class: v === undefined ? "" : v >= d.threshold ? "good" : "bad" }, v === undefined ? "—" : `${v}%`), ci ? h("span", { class: "ci" }, `${ci.low}–${ci.high} · 95%`) : null);
  const runs = (dev?.runs ?? []);
  const chart = runs.length ? (() => { const w = 400, hh = 100, x0 = 48, x1 = 380; const xs = runs.map((_, i) => runs.length > 1 ? x0 + 22 + ((x1 - x0 - 44) * i) / (runs.length - 1) : (x0 + x1) / 2); const y = (v) => 84 - (64 * v) / 100; const path = (k) => runs.map((r, i) => `${i ? "L" : "M"}${xs[i].toFixed(1)} ${y(r[k]).toFixed(1)}`).join(" "); return h("svg", { viewBox: `0 0 ${w} ${hh}`, width: "100%", height: hh, role: "img", "aria-label": `TPR and TNR across ${runs.length} dev runs against the ${d.threshold}% target`, html: `<line x1="${x0}" y1="${y(d.threshold)}" x2="${x1}" y2="${y(d.threshold)}" stroke="var(--good)" stroke-dasharray="4 4"/><text x="${x1}" y="${y(d.threshold) - 6}" text-anchor="end" font-size="11" fill="var(--good)">${d.threshold}% target</text><path d="${path("tpr")}" fill="none" stroke="var(--blue)" stroke-width="2"/><path d="${path("tnr")}" fill="none" stroke="var(--warn)" stroke-width="2" stroke-dasharray="5 3"/>${runs.map((r, i) => `<text x="${xs[i]}" y="96" text-anchor="middle" font-size="11" fill="var(--ink-muted)">v${r.version ?? "?"}</text>`).join("")}<text x="6" y="${y(runs[runs.length - 1].tpr)}" font-size="11" font-weight="600" fill="var(--blue)">TPR</text><text x="6" y="${y(runs[runs.length - 1].tnr) + 12}" font-size="11" font-weight="600" fill="var(--warn)">TNR</text>` }); })() : null;
  const prog = h("span", { class: "progress-inline", "aria-live": "polite" }, d.running ? `Running ${d.running.split}: ${d.running.done}/${d.running.total}` : "");
  const runSplit = async (split) => { try { await api(`/api/judges/${encodeURIComponent(name)}/calibrate`, { method: "POST", body: JSON.stringify({ split }) }); prog.textContent = `Running ${split}…`; } catch (e) { prog.textContent = e.body?.message ?? e.message; } };
  const calibration = h("section", { class: "card side", "aria-label": "Calibration" },
    h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, "Calibration · dev set"), h("div", { class: "caption muted" }, `${d.splits.dev} dev traces · ${d.labels} labels (${d.fail_labels} Fail) · train ${d.splits.train} / dev ${d.splits.dev} / test ${d.splits.test}`)), h("button", { type: "button", class: "btn", disabled: Boolean(d.running) || d.splits.dev === 0, onclick: () => runSplit("dev") }, "Run on dev set")),
    prog,
    matrix ?? h("p", { class: "muted", style: "margin:0" }, "Dev has not run yet."),
    dev?.tpr !== undefined ? h("div", { class: "kpis" }, kpi("TPR", dev.tpr, dev.tpr_ci), kpi("TNR", dev.tnr, dev.tnr_ci), h("div", {}, h("span", {}, "Unknown"), h("span", {}, String(m?.unknown ?? 0)))) : null,
    chart ? h("div", { class: "field" }, h("span", {}, "TPR and TNR by version (dev)"), chart) : null,
    h("div", { class: "verdict", style: "align-items:center" }, h("button", { type: "button", class: "btn primary", disabled: !d.can_run_test || Boolean(d.running), onclick: () => { if (confirm(`Run the held-out test set once (${d.splits.test} traces)? It cannot be re-run for this prompt.`)) runSplit("test"); } }, d.test_done ? "Test set ran" : "Run test set once"), h("span", { class: "caption muted" }, d.test_done ? `Test: TPR ${test.tpr} / TNR ${test.tnr} · ${ago(test.ran_at)}` : d.can_run_test ? `Unlocked. Test split: ${d.splits.test} traces the judge has never seen.` : `Unlocks at step 3. Test split: ${d.splits.test} traces.`)));
  const dis = (cal?.disagreements ?? []);
  const disagreements = h("section", { class: "card", "aria-label": "Disagreements" }, h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, "Disagreements on dev"), h("div", { class: "caption muted" }, `${dis.length} traces where judge and human differ · a disputed verdict becomes a label`)), h("a", { href: "#/review" }, "Open queue")),
    dis.length ? h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Trace"), h("th", { scope: "col" }, "Human"), h("th", { scope: "col" }, "Judge"), h("th", { scope: "col" }, "Judge's critique"))), h("tbody", {}, ...dis.slice(0, 30).map((x) => h("tr", {}, h("td", {}, h("a", { class: "mono", href: `#/review/${encodeURIComponent(state.batches[0]?.name ?? "")}/${encodeURIComponent(x.trace_id)}` }, x.trace_id)), h("td", {}, h("span", { class: `pill ${x.human === "Fail" ? "bad" : "good"}` }, x.human)), h("td", {}, h("span", { class: `pill ${x.judge === "Fail" ? "bad" : x.judge === "Pass" ? "good" : ""}` }, x.judge)), h("td", { style: "font-size:13px;color:var(--ink-muted)" }, x.critique ?? ""))))) : h("p", { class: "muted", style: "margin:0" }, "None recorded."));
  page.replaceChildren(h("div", { class: "column" },
    h("header", { class: "page-header" }, h("div", { class: "titles" }, h("nav", { class: "breadcrumb", "aria-label": "Breadcrumb" }, h("a", { href: "#/judges" }, "Judges"), h("span", { class: "sep" }, "/"), h("span", { class: "mono" }, name)), h("div", { class: "title-row" }, h("h1", { class: "t-page-title mono" }, name), h("span", { class: `pill ${d.status === "trusted" ? "good" : d.status === "stale" || d.status === "dev" ? "warn" : ""}` }, `${d.label.replace(/^Judge · /, "")} · v${d.judge.data.version ?? 1}`)), h("p", { class: "subtitle" }, d.mode?.definition ?? "", ` Used by ${d.used_by.length} task${d.used_by.length === 1 ? "" : "s"}.`)), h("div", { class: "verdict" }, h("a", { href: `#/modes/${encodeURIComponent(name)}`, class: "btn" }, "Open failure mode"))),
    stepper, banner,
    h("div", { class: "two-col" }, definition, calibration),
    disagreements));
}

function renderSoon(title) { $("#page").replaceChildren(h("div", { class: "column" }, header(title), h("div", { class: "empty" }, `${title} arrives with a later step of Phase 1; see docs/SPEC.md. The data it will show is already in the evals/ directory.`))); }

// ---------------- router
async function render() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  state.route = parts.length ? parts : ["overview"];
  state.seq++;
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
      default: renderSoon(NAV.find(([, href]) => href === "#/" + state.route[0])?.[0] ?? "Not found");
    }
  } catch (e) { $("#page").replaceChildren(h("div", { class: "column" }, header("Something went wrong"), h("div", { class: "empty" }, e.message))); }
}
function keyHandler(e) { if (e.metaKey && e.key !== "Enter") return; review.keys?.(e); }
window.addEventListener("hashchange", render);
const events = new EventSource("/api/events");
for (const t of ["saved", "label", "committed", "discarded", "changed"]) events.addEventListener(t, () => { refreshHealth().catch(() => {}); if (t !== "label" && ["pending", "overview"].includes(state.route[0])) render(); });
events.addEventListener("calibrate", (e) => { const ev = JSON.parse(e.data); if (state.route[0] !== "judges" || state.route[1] !== ev.judge) return; const p = $(".progress-inline"); if (ev.state === "running" && p) p.textContent = `Running ${ev.split}: ${ev.done}/${ev.total}`; if (ev.state === "done" || ev.state === "failed") { if (p) p.textContent = ev.state === "failed" ? ev.message : `${ev.split} done · TPR ${ev.tpr ?? "—"} / TNR ${ev.tnr ?? "—"}`; judgePage.hashes = null; render(); } });
refreshHealth().then(render).catch((e) => { $("#page").replaceChildren(h("div", { class: "column" }, header("Cannot reach the server"), h("div", { class: "empty" }, e.message))); });
