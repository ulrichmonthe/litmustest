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
  ["Overview", "#/overview"], ["Review queue", "#/review"], ["Failure modes", "#/modes"], ["Tasks & suites", "#/tasks"],
  ["Run compare", "#/compare"], ["Transcripts", "#/transcripts"], ["Judges", "#/judges"], ["Settings", "#/settings"],
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

// ---------------- overview (read-only)
async function renderOverview() {
  const seq = state.seq; const page = $("#page");
  const o = await api("/api/overview");
  if (stale(seq)) return;
  const pct = (v) => (v === null || v === undefined ? "–" : `${Number(v).toFixed(1)}%`);
  const suiteCard = (s) => { const c = s.current; const hist = s.history; const w = 240, hh = 56; const pts = hist.map((v, i) => [hist.length > 1 ? (i * w) / (hist.length - 1) : w, hh - 2 - ((hh - 4) * v) / 100]);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
    return h("a", { class: "card suite-card", href: "#/tasks" },
      h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, s.name[0].toUpperCase() + s.name.slice(1)), h("div", { class: "kind" }, s.kind === "regression" ? "Should stay near 100%" : s.kind === "capability" ? "Hill to climb" : "Calibrated judges")), s.gate?.report_only ? h("span", { class: "pill" }, "Report only") : null),
      c ? h("div", { class: "big" }, h("span", { class: "n" }, pct(c.pass_rate)), h("span", { class: "ci" }, `± ${((c.ci.high - c.ci.low) / 2).toFixed(1)}`)) : h("div", { class: "big" }, h("span", { class: "n muted" }, "–"), h("span", { class: "ci" }, "no run yet")),
      s.delta ? h("div", { class: `delta ${s.delta.significant ? (s.delta.pts >= 0 ? "good" : "bad") : "muted"}` }, `${s.delta.pts >= 0 ? "+" : "−"}${Math.abs(s.delta.pts)} pts`, h("span", { class: "note" }, `vs ${o.previous?.run_id ?? "previous"} · ${s.delta.note}`)) : h("div", { class: "delta muted" }, "no previous run"),
      hist.length > 1 ? h("svg", { viewBox: `0 0 ${w} ${hh}`, width: "100%", height: hh, role: "img", "aria-label": `${s.name} pass rate over the last ${hist.length} runs, from ${hist[0]} to ${hist[hist.length - 1]} percent`, html: `<path d="${line} L${w} ${hh} L0 ${hh} Z" fill="var(--blue)" fill-opacity="0.12"/><path d="${line}" fill="none" stroke="var(--blue)" stroke-width="2"/><circle cx="${pts[pts.length - 1][0]}" cy="${pts[pts.length - 1][1]}" r="3.5" fill="var(--blue)"/>` }) : null,
      h("div", { class: "stats" }, h("div", {}, h("span", {}, "pass@1"), h("span", {}, c ? pct(c.pass_at_1) : "–")), h("div", {}, h("span", {}, `pass^${c?.k ?? 5}`), h("span", {}, c ? pct(c.pass_hat_k) : "–")), h("div", {}, h("span", {}, "Tasks"), h("span", {}, String(c?.n_tasks ?? s.n_tasks))))); };
  const alerts = h("section", { class: "card", "aria-label": "Needs attention" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Needs attention"), h("span", { class: "caption" }, "Eval health, checked from the files")),
    ...(o.alerts.length ? o.alerts.map((a) => h("div", { class: "alert" }, h("span", { class: `pill ${a.level === "bad" ? "bad" : a.level === "warn" ? "warn" : ""}` }, a.kind), h("span", { class: "body" }, h("strong", {}, a.title), " ", h("span", {}, a.body)), h("a", { href: a.href }, a.action))) : [h("p", { class: "muted", style: "margin:0" }, "Nothing needs attention.")]));
  const maxMode = Math.max(1, ...o.modes.items.map((m) => m.count));
  const modesCard = h("section", { class: "card main", "aria-label": "Failure modes" }, h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, "Failure modes"), h("div", { class: "caption muted" }, o.modes.source === "run" ? `Failed checks in ${o.run.run_id} · the top three are ${o.modes.top3_share}% of all failures` : `Fail labels from the review queue · ${o.labels.total} labels on ${o.labels.traces} traces`)), h("a", { href: "#/modes" }, "Open taxonomy")),
    h("div", { class: "pareto-head", style: "grid-template-columns:170px minmax(0,1fr) 44px 64px 64px" }, h("span", {}, "Mode"), h("span"), h("span", { style: "text-align:right" }, "Fails"), h("span", {}, "Severity"), h("span", { style: "text-align:right" }, o.previous ? `vs ${o.previous.run_id.replace(/^run_0*/, "#")}` : "")),
    ...o.modes.items.slice(0, 7).map((m) => h("a", { class: "pareto-row", style: "grid-template-columns:170px minmax(0,1fr) 44px 64px 64px;color:inherit", href: `#/modes/${encodeURIComponent(m.name)}` }, h("span", { class: "mono" }, m.name), h("span", { class: "bar" }, h("span", { style: `width:${(100 * m.count) / maxMode}%` })), h("span", { class: "n" }, String(m.count)), h("span", { class: `pill ${m.severity === "high" ? "bad" : m.severity === "med" ? "warn" : ""}` }, m.severity === "med" ? "Med" : m.severity[0].toUpperCase() + m.severity.slice(1)), h("span", { class: `n ${m.prev === null ? "muted" : m.count - m.prev > 0 ? "" : ""}`, style: m.prev === null ? "" : m.count - m.prev > 0 ? "color:var(--bad)" : m.count - m.prev < 0 ? "color:var(--good)" : "color:var(--ink-muted)" }, m.prev === null ? "" : `${m.count - m.prev > 0 ? "+" : m.count - m.prev < 0 ? "−" : ""}${Math.abs(m.count - m.prev)}`))));
  const judges = h("section", { class: "card side", "aria-label": "Judge trust" }, h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, "Judge trust"), h("div", { class: "caption muted" }, "Held-out test set · target TPR and TNR ≥ 90%")), h("a", { href: "#/judges" }, "All judges")),
    o.judges.length ? h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Judge"), h("th", { scope: "col", style: "text-align:right" }, "TPR"), h("th", { scope: "col", style: "text-align:right" }, "TNR"), h("th", { scope: "col", style: "text-align:right" }, "Labels"), h("th", { scope: "col" }, "Status"))), h("tbody", {}, ...o.judges.map((j) => h("tr", {}, h("td", {}, h("a", { class: "mono", href: `#/judges/${j.name}` }, j.name)), h("td", { class: "num" }, j.tpr === null || j.status === "stale" ? "—" : `${j.tpr}%`), h("td", { class: "num" }, j.tnr === null || j.status === "stale" ? "—" : `${j.tnr}%`), h("td", { class: "num" }, String(j.labels)), h("td", {}, h("span", { class: `pill ${j.status === "trusted" ? "good" : j.status === "stale" || j.status === "dev" ? "warn" : ""}` }, j.status === "trusted" ? "Trusted" : j.status === "stale" ? "Stale" : j.status === "dev" ? "Below target" : "Untested")))))) : h("p", { class: "muted", style: "margin:0" }, "No judges yet."),
    h("div", { class: "card-head", style: "margin-top:8px" }, h("h2", { class: "t-section-title" }, "Review coverage"), h("span", { class: "caption" }, "labeled / in batch")),
    ...(o.coverage.length ? o.coverage.map((c) => h("div", { class: "cluster-row" }, h("a", { class: "terms", href: `#/review/${encodeURIComponent(c.name)}` }, `${c.name} · ${c.clusters} clusters`), h("div", { class: "bar" }, h("span", { style: `width:${c.items ? (100 * c.labelled) / c.items : 0}%` })), h("span", { class: "frac" }, `${c.labelled}/${c.items}`))) : [h("p", { class: "muted", style: "margin:0" }, "No batch yet.")]));
  const flips = h("section", { class: "card", "aria-label": "Flipped tasks" }, h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, "Tasks that flipped"), h("div", { class: "caption muted" }, o.previous ? `${o.run.run_id} vs ${o.previous.run_id}` : "needs two runs")), h("a", { href: "#/compare" }, "Compare runs")),
    o.flips.length ? h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Task"), h("th", { scope: "col" }, "Suite"), h("th", { scope: "col" }, "Change"), h("th", { scope: "col", style: "text-align:right" }, "Trials"), h("th", { scope: "col" }, "Why"))), h("tbody", {}, ...o.flips.map((f) => h("tr", {}, h("td", {}, h("a", { class: "mono", href: `#/tasks/${encodeURIComponent(f.suite)}/${encodeURIComponent(f.task)}` }, f.task)), h("td", {}, f.suite), h("td", {}, h("span", { class: `pill ${f.change === "Broke" ? "bad" : f.change === "Fixed" ? "good" : "warn"}` }, f.change)), h("td", { class: "num" }, f.trials), h("td", {}, f.why ? h("span", { class: "why" }, f.why.claude ?? f.why.headline, f.transcript ? h("a", { href: f.transcript }, " Read the trial →") : null) : f.check ? h("span", { class: "mono" }, f.check) : "—"))))) : h("p", { class: "muted", style: "margin:0" }, "No flips between the last two runs."));
  const v = o.verdict;
  page.replaceChildren(h("div", { class: "column" },
    h("header", { class: "page-header" }, h("div", { class: "titles" }, h("h1", { class: "t-page-title" }, "Overview"), h("p", { class: "subtitle" }, o.run ? [h("span", { class: "mono" }, o.run.run_id), ` (${o.run.branch ?? "?"} @ ${o.run.commit})${o.previous ? ` vs ${o.previous.run_id}` : ""} · ${o.run.trials} trials per task · infra errors ${o.run.infra_error_rate}% · $${o.run.cost_usd}`] : "No run summaries under evals/runs/ yet.")), h("div", { class: "verdict" }, h("a", { href: "#/compare", class: "btn" }, "Compare runs"))),
    h("section", { class: "verdict-strip", "aria-label": "Verdict" }, h("span", { class: "dot", "aria-hidden": "true", style: `background:${v.tone === "good" ? "#6fcf97" : v.tone === "bad" ? "#f08c84" : "#b3aea6"}` }), h("p", {}, h("strong", {}, v.lead), " ", v.rest), v.aside ? h("span", { class: "aside" }, v.aside, " · ", h("a", { href: "#/judges" }, "Fix judge")) : null),
    h("div", { class: "suite-grid" }, ...o.suites.map(suiteCard)),
    alerts,
    h("div", { class: "two-col" }, modesCard, judges),
    flips));
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

// ---------------- run compare
const cmp = { filter: "all" };
async function renderCompare(aId, bId) {
  const seq = state.seq; const page = $("#page");
  const { runs } = await api("/api/runs"); if (stale(seq)) return;
  if (runs.length < 2) { page.replaceChildren(h("div", { class: "column" }, header("Run compare", "Needs two run summaries."), h("div", { class: "empty" }, runs.length ? "Only one run under evals/runs/. Run the suites again after a change, then compare." : "No runs yet. Run `litmustest run` to produce one."))); return; }
  const b = bId ?? runs[0].run_id, a = aId ?? (runs.find((r) => r.run_id !== b)?.run_id ?? runs[1].run_id);
  const c = await api(`/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`); if (stale(seq)) return;
  const sel = (label, val, onchange) => h("label", { class: "field", style: "flex:1 1 200px" }, h("span", {}, label), h("select", { class: "select", onchange }, ...runs.map((r) => h("option", { value: r.run_id, selected: r.run_id === val }, `${r.run_id} · ${r.branch ?? "?"} @ ${r.commit}`))));
  const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
  const suiteCard = (s) => { const x = (v) => 120 + Math.max(-10, Math.min(10, v)) * 11; return h("div", { class: "card delta-card" }, h("div", { class: "card-head" }, h("span", { class: "t-section-title" }, s.name), h("span", { class: "caption" }, `${s.n_tasks} tasks`)), h("div", { class: "big" }, h("span", { class: `n ${s.significant ? (s.delta >= 0 ? "" : "") : "muted"}`, style: s.significant ? `color:${s.delta >= 0 ? "var(--good)" : "var(--bad)"}` : "" }, `${sign(s.delta)} pts`), h("span", { class: "ci" }, `${sign(s.ci.low)}…${sign(s.ci.high)}`)), h("span", { class: `pill ${s.significant ? (s.delta >= 0 ? "good" : "bad") : ""}` }, s.note), h("svg", { class: "axis", viewBox: "0 0 240 44", role: "img", "aria-label": `${s.name}: ${sign(s.delta)} points, interval ${sign(s.ci.low)} to ${sign(s.ci.high)}`, html: `<line x1="120" y1="4" x2="120" y2="40" stroke="var(--line)"/><line x1="${x(s.ci.low)}" y1="22" x2="${x(s.ci.high)}" y2="22" stroke="var(--blue)" stroke-width="3" stroke-linecap="round"/><circle cx="${x(s.delta)}" cy="22" r="5" fill="var(--blue)"/><text x="4" y="40" font-size="10" fill="var(--ink-faint)">−10</text><text x="120" y="40" font-size="10" fill="var(--ink-faint)" text-anchor="middle">0</text><text x="236" y="40" font-size="10" fill="var(--ink-faint)" text-anchor="end">+10 pts</text>` }), h("div", { class: "stats" }, h("div", {}, h("span", {}, "A"), h("span", {}, `${s.a}%`)), h("div", {}, h("span", {}, "B"), h("span", {}, `${s.b}%`)), h("div", {}, h("span", {}, "Flips"), h("span", {}, String(s.flips)))), s.gate_result ? h("span", { class: `caption ${s.gate_result.passed ? "muted" : ""}`, style: s.gate_result.passed ? "" : "color:var(--bad)" }, s.gate_result.passed ? (s.gate?.report_only ? "Report only" : "Gate: ok") : `Gate: ${s.gate_result.reasons.join("; ")}`) : null); };
  const flips = c.flips.filter((f) => cmp.filter === "all" || f.change.toLowerCase() === cmp.filter);
  const filterBtn = (key, label, n) => h("button", { type: "button", "aria-pressed": cmp.filter === key ? "true" : "false", onclick: () => { cmp.filter = key; renderCompare(a, b); } }, `${label} ${n}`);
  const flipTable = h("section", { class: "card main", "aria-label": "Flip list" }, h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, "Tasks that changed"), h("div", { class: "caption muted" }, "Majority verdict across trials · click a task for its transcripts")), h("div", { class: "filter", role: "group", "aria-label": "Filter" }, filterBtn("all", "All", c.flips.length), filterBtn("broke", "Broke", c.flips.filter((f) => f.change === "Broke").length), filterBtn("fixed", "Fixed", c.flips.filter((f) => f.change === "Fixed").length), filterBtn("flaky", "Flaky", c.flips.filter((f) => f.change === "Flaky").length))),
    flips.length ? h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Task"), h("th", { scope: "col" }, "Suite"), h("th", { scope: "col" }, "A → B"), h("th", { scope: "col" }, "Change"), h("th", { scope: "col" }, "Failing check in B"))), h("tbody", {}, ...flips.map((f) => h("tr", {}, h("td", {}, h("a", { class: "mono", href: f.transcript_ref ? `#/transcripts/${encodeURIComponent(f.transcript_ref.replace(/^local:/, ""))}` : "#/transcripts" }, f.task)), h("td", {}, f.suite), h("td", { class: "num" }, `${f.a} → ${f.b}`), h("td", {}, h("span", { class: `pill ${f.change === "Broke" ? "bad" : f.change === "Fixed" ? "good" : "warn"}` }, f.change)), h("td", {}, f.why ? h("span", { class: "why" }, f.why.claude ?? f.why.headline, f.transcript ? h("a", { href: f.transcript }, " Read the trial →") : null) : f.check ? h("span", { class: "mono" }, f.check) : "—"))))) : h("p", { class: "muted", style: "margin:0" }, "No tasks changed."));
  const modes = h("section", { class: "card side", "aria-label": "Failure-mode deltas" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Failed checks by failure mode"), h("span", { class: "caption" }, "A → B")), ...(c.modes.length ? c.modes.map((m) => h("div", { class: "cluster-row", style: "grid-template-columns:minmax(0,1fr) 70px 48px" }, h("a", { class: "mono", href: `#/modes/${encodeURIComponent(m.name)}` }, m.name), h("span", { class: "frac" }, `${m.a} → ${m.b}`), h("span", { class: "frac", style: m.delta > 0 ? "color:var(--bad)" : m.delta < 0 ? "color:var(--good)" : "" }, sign(m.delta)))) : [h("p", { class: "muted", style: "margin:0" }, "No failed checks in either run.")]),
    h("div", { class: "card-head", style: "margin-top:8px" }, h("h2", { class: "t-section-title" }, "Cost")), h("div", { class: "cost-grid" }, h("div", {}, h("span", {}, "Dollars"), h("span", {}, `$${c.cost.a} → $${c.cost.b}`)), h("div", {}, h("span", {}, "Tokens"), h("span", {}, `${c.cost.tokens_a} → ${c.cost.tokens_b}`)), h("div", {}, h("span", {}, "Mean latency"), h("span", {}, `${c.cost.latency_a} → ${c.cost.latency_b} ms`)), h("div", {}, h("span", {}, "Infra errors"), h("span", {}, `${c.cost.infra_a}% → ${c.cost.infra_b}%`))));
  const status = h("span", { class: "status", "aria-live": "polite" });
  page.replaceChildren(h("div", { class: "column" },
    h("header", { class: "page-header" }, h("div", { class: "titles" }, h("h1", { class: "t-page-title" }, "Run compare"), h("p", { class: "subtitle" }, `Paired comparison: the same ${c.common_tasks} tasks, ${c.b.trials} trials each, on two versions of the agent`)), h("div", { class: "two-col", style: "flex:1 1 420px" }, sel("A (baseline)", a, (e) => { location.hash = `#/compare/${encodeURIComponent(e.target.value)}/${encodeURIComponent(b)}`; }), sel("B (candidate)", b, (e) => { location.hash = `#/compare/${encodeURIComponent(a)}/${encodeURIComponent(e.target.value)}`; }))),
    h("section", { class: "verdict-strip", "aria-label": "Verdict" }, h("span", { class: "dot", "aria-hidden": "true", style: `background:${c.verdict.tone === "good" ? "#6fcf97" : c.verdict.tone === "bad" ? "#f08c84" : "#b3aea6"}` }), h("p", {}, c.verdict.text), h("span", { class: "aside" }, c.gates_passed ? "Gates: pass" : "Gates: crossed")),
    h("div", { class: "suite-grid" }, ...c.suites.map(suiteCard)),
    h("div", { class: "two-col" }, flipTable, modes),
    h("div", { class: "save-row" }, h("button", { type: "button", class: "btn", onclick: async () => { try { await navigator.clipboard.writeText(c.markdown); status.textContent = "Copied the markdown for a PR comment."; } catch { status.textContent = "Copy failed; use litmustest compare --markdown."; } } }, "Copy as PR comment"), status)));
}

// ---------------- transcripts
async function renderTranscripts(runId) {
  const seq = state.seq; const page = $("#page");
  const d = await api(`/api/transcripts${runId ? `?run=${encodeURIComponent(runId)}` : ""}`); if (stale(seq)) return;
  if (!d.run) { page.replaceChildren(h("div", { class: "column" }, header("Transcripts", "No runs yet."), h("div", { class: "empty" }, "Run `litmustest run` to produce trials, then read them here."))); return; }
  const rows = d.tasks.map((t) => h("div", { class: "task-row" }, h("div", {}, h("a", { class: "mono", href: `#/transcripts/${encodeURIComponent(d.run.run_id)}/${encodeURIComponent(t.id)}/${t.trials.findIndex((x) => !x.pass) + 1 || 1}` }, t.id), " ", h("span", { class: "caption muted" }, t.suite), t.flaky ? h("span", { class: "pill warn", style: "margin-left:8px" }, "Flaky") : null, t.likely_broken ? h("span", { class: "pill bad", style: "margin-left:8px" }, "Likely broken") : null), h("span", { class: "num mono", style: "font-weight:400" }, `${t.strict_pass}%`), h("span", { class: "num mono", style: "font-weight:400" }, `w ${t.weighted}`), h("div", { class: "dots", "aria-label": `${t.trials.length} trials` }, ...t.trials.map((x) => h("a", { href: `#/transcripts/${encodeURIComponent(d.run.run_id)}/${encodeURIComponent(t.id)}/${x.n}`, title: `Trial ${x.n}: ${x.infra_error ? "infra " + x.infra_error_kind : x.pass ? "pass" : "fail " + x.failed_checks.join(", ")}` }, h("span", { class: x.infra_error ? "infra" : x.pass ? "" : "fail" }))))));
  page.replaceChildren(h("div", { class: "column" },
    h("header", { class: "page-header" }, h("div", { class: "titles" }, h("h1", { class: "t-page-title" }, "Transcripts"), h("p", { class: "subtitle" }, h("span", { class: "mono" }, d.run.run_id), ` · ${d.run.branch ?? "?"} @ ${d.run.commit} · ${d.run.trials} trials per task · tasks sorted by pass rate`)), h("label", { class: "field" }, h("span", {}, "Run"), h("select", { class: "select", onchange: (e) => { location.hash = `#/transcripts/${encodeURIComponent(e.target.value)}`; } }, ...d.runs.map((r) => h("option", { value: r.run_id, selected: r.run_id === d.run.run_id }, `${r.run_id} · ${r.branch ?? "?"} @ ${r.commit}`))))),
    h("section", { class: "card", "aria-label": "Tasks" }, h("div", { class: "task-row", style: "font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--ink-muted);min-height:32px" }, h("span", {}, "Task"), h("span", {}, "Strict"), h("span", {}, "Weighted"), h("span", {}, "Trials")), ...rows)));
}

const tr = { annotator: localStorage.getItem("litmustest.annotator") || "" };
// What happened, in plain words: the template from the data, then Claude's reading if someone asked for it.
const KIND_PILL = { pass: "good", not_built: "blue", broke: "bad", quality: "warn", infra: "", broken_task: "warn", grader_doubt: "warn", flaky: "warn" };
function explainCard(d, onExplain) {
  const x = d.explain; if (!x) return null;
  const c = x.claude; const status = h("span", { class: "status", "aria-live": "polite" });
  const ask = async (btn) => { btn.disabled = true; status.textContent = "Claude is reading the transcript…"; status.className = "status"; try { await onExplain(); } catch (e) { status.textContent = e.message; status.className = "status bad"; btn.disabled = false; } };
  const row = (label, ...body) => h("div", { class: "explain-row" }, h("span", { class: "eyebrow" }, label), h("div", {}, ...body));
  const claude = x.kind === "pass" ? null : c
    ? h("div", { class: "explain-claude" }, h("div", { class: "card-head" }, h("span", { class: "t-section-title", style: "font-size:14px" }, "Claude's reading"), h("span", { class: "caption muted" }, `${c.confidence ?? "low"} confidence · ${c.model} · ${ago(c.at)}`)),
        h("p", {}, c.summary), c.cause ? h("p", {}, h("strong", {}, "Likely cause. "), c.cause) : null, c.fix ? h("p", {}, h("strong", {}, "Fix. "), c.fix) : null,
        h("div", { class: "row-actions" }, h("span", { class: "caption muted" }, "Advice, not a verdict: it never changes the checks or the score."), h("button", { type: "button", class: "linklike", onclick: (e) => ask(e.currentTarget) }, "Explain again"), status))
    : h("div", { class: "explain-claude empty-claude" }, h("span", { class: "caption muted" }, "Want the why? Claude reads the transcript and saves a short explanation in the run summary, as a pending change."), h("button", { type: "button", class: "btn", onclick: (e) => ask(e.currentTarget) }, "Ask Claude to explain"), status);
  return h("section", { class: "card explain", "aria-label": "What happened" },
    h("div", { class: "explain-head" }, h("span", { class: `pill ${KIND_PILL[x.kind] ?? ""}` }, x.title.replace(/\.$/, "")), h("h2", { class: "t-section-title" }, x.headline)),
    row("What it tests", h("p", {}, x.tested), d.task.source ? h("p", { class: "caption muted" }, `Written from ${d.task.source}`) : null),
    x.kind !== "pass" ? row("What happened", h("p", {}, x.happened), x.where ? h("a", { href: `#step-${x.where.step}`, onclick: (e) => { e.preventDefault(); document.getElementById(`step-${x.where.step}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); } }, `Jump to step ${x.where.step + 1} in the timeline ↓`) : null) : null,
    row("What this means", h("p", {}, x.meaning)),
    x.to_pass.length ? row("To make it pass", h("ul", {}, ...x.to_pass.map((t) => h("li", {}, t)))) : null,
    x.failed.filter((f) => f.mode_definition).length ? row("Failure mode", ...x.failed.filter((f) => f.mode_definition).map((f) => h("p", { class: "caption" }, h("a", { class: "mono", href: `#/modes/${encodeURIComponent(f.failure_mode)}` }, f.failure_mode), ` · ${f.mode_definition}`))) : null,
    claude);
}
async function renderTrial(runId, taskId, n) {
  const seq = state.seq; const page = $("#page");
  let d; try { d = await api(`/api/transcripts/${encodeURIComponent(runId)}/${encodeURIComponent(taskId)}/${n}`); } catch (e) { page.replaceChildren(h("div", { class: "column" }, header("Trial not found", e.message))); return; }
  if (stale(seq)) return;
  const v = d.view; const grades = d.grades; const s = d.summary;
  const gradeAt = (i) => grades.filter((g) => g.step === i);
  const checkPanel = (g) => h("div", { class: `check-panel${g.excluded ? " dashed" : ""}` }, h("span", { class: `pill ${g.excluded ? "" : g.pass === true ? "good" : g.pass === false ? "bad" : "warn"}` }, g.excluded ? "Excluded" : g.pass === true ? "Pass" : g.pass === false ? "Fail" : "Unknown"), h("div", { class: "mid" }, h("span", { class: "mono" }, g.check, h("span", { class: "faint", style: "font-weight:400" }, ` · ${g.type}${g.failure_mode ? ` · ${g.failure_mode}` : ""}`)), h("span", { class: "why" }, g.reason), g.critique ? h("span", { class: "critique" }, `“${g.critique}”`) : null), g.type === "judge" && !g.excluded ? h("button", { type: "button", class: "linklike", onclick: () => disputeVerdict(g) }, `Dispute: human says ${g.verdict === "Fail" ? "Pass" : "Fail"}`) : g.type === "code" ? h("a", { href: "#/judges" }, "View source") : null);
  const steps = []; let turn = 0;
  if (v) v.turns.forEach((t, i) => { turn += t.role === "user" ? 1 : 0; const time = `${(i * 0.9).toFixed(1)}s`;
    const body = t.role === "tool" ? (() => { const c = v.calls.find((x) => x.span_id === `call_${v.turns.slice(0, i).filter((y) => y.role === "tool").length}`) ?? { name: t.tool, args: {}, result: t.content, ok: true }; return [h("div", { class: "step-head" }, h("span", { class: "eyebrow" }, "Tool"), h("span", { class: "mono" }, c.name), !c.ok && h("span", { class: "pill bad" }, "Error")), h("pre", { class: `code-block${c.ok ? "" : " bad"}` }, `${c.name}(${fmtArgs(c.args)})\n`, h("span", { class: c.ok ? "result" : "error" }, `→ ${short(c.result ?? "", 300)}`))]; })() : [h("div", { class: "step-head" }, h("span", { class: "eyebrow" }, t.role === "agent" ? "Agent" : t.role === "system" ? "System" : i === 0 ? "Test input" : "User"), h("span", { class: "faint", style: "font-size:12px" }, `Turn ${turn || 1}`)), h("p", { class: `bubble ${t.role === "agent" ? "agent" : "customer"}` }, t.content)];
    const problem = d.explain?.where?.step === i;
    const li = step(time, problem ? "bad" : t.role === "agent" ? "agent" : "", [...(problem ? [h("div", { class: "problem-flag" }, "First thing that went wrong")] : []), ...body, ...gradeAt(i).map(checkPanel)]);
    li.id = `step-${i}`; if (problem) li.classList.add("problem"); steps.push(li); });
  const unpinned = grades.filter((g) => g.step === undefined || g.step === null || !v || g.step >= v.turns.length);
  const tone = s.infra_error ? "neutral" : s.pass ? "good" : "bad";
  const trialTitle = { agent: s.pass ? "Passed." : "Blamed on the product.", grader: "Blamed on the grader.", task: "Blamed on the task.", infra: "Blamed on the infrastructure." };
  const trialText = { agent: s.failed_checks.length ? "The checks are right and the product fell short. Override if the test itself is wrong." : "Every check passed.", grader: "Only judge verdicts failed or were Unknown; read the critique before trusting it.", task: "This task fails every trial across runs; its premise or environment is wrong, not the agent.", infra: `${d.infra?.kind ?? "infra"}: ${d.infra?.message ?? ""}` };
  const current = s.triage?.verdict ?? d.triage_suggested;
  const status = h("span", { class: "status", "aria-live": "polite" });
  const triage = async (verdict) => { try { await api(`/api/transcripts/${encodeURIComponent(runId)}/${encodeURIComponent(taskId)}/${n}/triage`, { method: "POST", body: JSON.stringify({ verdict, by: tr.annotator || "dashboard" }) }); status.textContent = `Triage saved: ${verdict}. The run summary is in the Pending changes tray.`; status.className = "status good"; await refreshHealth(); renderTrial(runId, taskId, n); } catch (e) { status.textContent = e.body?.message ?? e.message; status.className = "status bad"; } };
  const override = () => { const v2 = prompt("Triage verdict: agent, grader, task or infra", current); if (v2 && ["agent", "grader", "task", "infra"].includes(v2)) triage(v2); };
  async function disputeVerdict(g) { const label = g.verdict === "Fail" ? "Pass" : "Fail"; const note = prompt(`Dispute ${g.check}: the human says ${label}. Why? (becomes the label's note)`, ""); if (note === null) return; try { const r = await api(`/api/transcripts/${encodeURIComponent(runId)}/${encodeURIComponent(taskId)}/${n}/dispute`, { method: "POST", body: JSON.stringify({ check: g.check, label, note, annotator: tr.annotator || "dashboard" }) }); status.textContent = `Labelled ${r.trace_id} ${label} for ${r.failure_mode}; it will feed the judge's calibration.`; status.className = "status good"; await refreshHealth(); } catch (e) { status.textContent = e.body?.message ?? e.message; status.className = "status bad"; } }
  const strip = h("div", { class: "trial-strip", role: "group", "aria-label": "Trials" }, ...d.trials.map((x) => h("button", { type: "button", "aria-pressed": x.n === n ? "true" : "false", onclick: () => { location.hash = `#/transcripts/${encodeURIComponent(runId)}/${encodeURIComponent(taskId)}/${x.n}`; } }, h("span", {}, String(x.n)), h("span", { class: x.infra_error ? "muted" : x.pass ? "" : "", style: x.infra_error ? "" : `color:${x.pass ? "var(--good)" : "var(--bad)"}` }, x.infra_error ? "infra" : x.pass ? "pass" : "fail"))));
  const outcome = d.outcome.length ? h("section", { class: "card side", "aria-label": "Outcome" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "End state"), h("span", { class: "caption" }, "expected vs actual")), h("table", { class: "plain state-table" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Path"), h("th", { scope: "col" }, "Expected"), h("th", { scope: "col" }, "Actual"), d.reference_available ? h("th", { scope: "col" }, "Reference") : null)), h("tbody", {}, ...d.outcome.map((o) => { const same = JSON.stringify(o.expected) === JSON.stringify(o.actual); return h("tr", {}, h("td", { class: "mono", style: "font-weight:400" }, o.path), h("td", { class: "mono", style: "font-weight:400" }, JSON.stringify(o.expected)), h("td", { class: `mono${same ? "" : " diff"}`, style: "font-weight:400" }, o.actual === undefined ? "—" : JSON.stringify(o.actual)), d.reference_available ? h("td", { class: "mono", style: "font-weight:400;color:var(--ink-muted)" }, JSON.stringify(o.reference)) : null); })))) : null;
  page.replaceChildren(h("div", { class: "column" },
    h("header", { class: "page-header" }, h("div", { class: "titles" }, h("nav", { class: "breadcrumb", "aria-label": "Breadcrumb" }, h("a", { href: `#/transcripts/${encodeURIComponent(runId)}` }, runId), h("span", { class: "sep" }, "/"), h("span", {}, d.task.suite), h("span", { class: "sep" }, "/"), h("span", { class: "mono" }, taskId), h("span", { class: "sep" }, "/"), h("span", {}, `Trial ${n} of ${d.trials.length}`)), h("div", { class: "title-row" }, h("h1", { class: "t-page-title mono" }, taskId), h("span", { class: `pill ${tone === "good" ? "good" : tone === "bad" ? "bad" : ""}` }, s.infra_error ? "Infra error" : s.pass ? "Passed" : "Failed"), d.task.flaky ? h("span", { class: "pill warn" }, "Flaky") : null, d.task.likely_broken ? h("span", { class: "pill bad" }, "Likely broken") : null), h("p", { class: "subtitle" }, `Task weighted `, h("span", { class: "mono" }, d.task.weighted !== undefined ? `${d.task.weighted}` : "—"), ` · ${v ? v.turns.filter((t) => t.role !== "tool").length : "?"} turns · ${v ? v.calls.length : "?"} tool calls${s.tokens ? ` · ${s.tokens} tokens` : ""}${s.latency_ms ? ` · ${(s.latency_ms / 1000).toFixed(1)} s` : ""}`)), h("div", { role: "group", "aria-label": "Trials", style: "display:flex;flex-direction:column;gap:8px" }, h("span", { class: "eyebrow" }, `Trials · ${d.trials.filter((x) => x.pass).length} of ${d.trials.length} passed`), strip)),
    explainCard(d, async () => { await api(`/api/transcripts/${encodeURIComponent(runId)}/${encodeURIComponent(taskId)}/${n}/explain`, { method: "POST", body: "{}" }); await refreshHealth(); await renderTrial(runId, taskId, n); }),
    h("section", { class: "verdict-strip", "aria-label": "Triage", title: "Who is at fault for this result: the product, the grader, the task or the infrastructure" }, h("span", { class: "dot", "aria-hidden": "true", style: `background:${tone === "good" ? "#6fcf97" : tone === "bad" ? "#f08c84" : "#b3aea6"}` }), h("p", {}, h("strong", {}, trialTitle[current]), " ", trialText[current]), h("div", { style: "display:flex;flex-wrap:wrap;align-items:center;gap:10px" }, h("span", { class: "aside" }, s.triage ? `Confirmed: ${{ agent: "the product", grader: "the grader", task: "the task", infra: "the infrastructure" }[s.triage.verdict] ?? s.triage.verdict} · by ${s.triage.by} · ${ago(s.triage.at)}` : "Triage suggested by the runner"), !s.triage ? h("button", { type: "button", class: "btn", style: "background:var(--slate-ink);color:var(--slate);border:0", onclick: () => triage(current) }, "Confirm") : null, h("button", { type: "button", class: "btn", style: "background:transparent;color:var(--slate-ink);border:1px solid var(--ink-muted)", onclick: override }, "Override"))),
    h("div", { class: "two-col" },
      h("section", { class: "card main", "aria-label": "Timeline" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Timeline"), h("span", { class: "caption" }, "Each check sits on the step it judged")), v ? h("ol", { class: "timeline" }, ...steps) : h("div", { class: "empty" }, d.infra ? `${d.infra.kind}: ${d.infra.message ?? ""}` : "The trial's transcript is not in the local store."), d.infra?.stderr ? h("pre", { class: "code-block bad" }, d.infra.stderr) : null, unpinned.length ? h("div", { class: "field" }, h("span", {}, "Checks"), ...unpinned.map(checkPanel)) : null),
      h("div", { class: "side" }, outcome, h("section", { class: "card", "aria-label": "Checks" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Checks"), h("span", { class: "caption" }, `${grades.filter((g) => g.pass === true).length} pass · ${grades.filter((g) => g.pass === false).length} fail · ${grades.filter((g) => g.excluded).length} excluded`)), ...grades.map((g) => h("div", { class: "lint " + (g.excluded ? "" : g.pass === true ? "ok" : g.pass === false ? "no" : "") }, h("span", { class: "mark", "aria-hidden": "true" }, g.excluded ? "–" : g.pass === true ? "✓" : g.pass === false ? "!" : "?"), h("span", { class: "mono", style: "font-weight:400" }, g.check), h("span", { class: "caption muted" }, `w${g.weight}`))), h("div", { class: "save-row" }, h("input", { class: "text", placeholder: "annotator", "aria-label": "Annotator", value: tr.annotator, style: "max-width:160px", oninput: (e) => { tr.annotator = e.target.value; localStorage.setItem("litmustest.annotator", e.target.value); } }), status))))));
}

// ---------------- tasks & suites
const tasksPage = { suite: null, filter: "", mode: "" };
async function renderTasks(suiteName, taskId) {
  const seq = state.seq; const page = $("#page");
  const d = await api("/api/tasks"); if (stale(seq)) return;
  if (taskId) return renderTaskEditor(d, taskId);
  const suite = suiteName ?? tasksPage.suite ?? d.suites[0]?.name; tasksPage.suite = suite;
  const status = h("span", { class: "status", "aria-live": "polite" });
  const graduate = async (ids) => { if (!confirm(`Move ${ids.length} task${ids.length > 1 ? "s" : ""} to regression? The task files and suite lists change as pending edits.`)) return; try { const r = await api("/api/graduate", { method: "POST", body: JSON.stringify({ tasks: ids }) }); status.textContent = `Moved ${r.moved.length} to regression; in the Pending changes tray.${r.refused.length ? ` Refused: ${r.refused.map((x) => x.task).join(", ")}` : ""}`; status.className = "status good"; await refreshHealth(); renderTasks(suite); } catch (e) { status.textContent = e.message; status.className = "status bad"; } };
  const cards = h("section", { class: "suite-pick", "aria-label": "Suites" }, ...d.suites.map((s) => h("button", { type: "button", "aria-pressed": s.name === suite ? "true" : "false", onclick: () => { location.hash = `#/tasks/${encodeURIComponent(s.name)}`; } }, h("span", {}, h("span", { class: "nm" }, s.name[0].toUpperCase() + s.name.slice(1)), " ", h("span", { class: "job" }, s.kind === "regression" ? "Should stay near 100%" : s.kind === "capability" ? "Hill to climb" : "Calibrated judges")), h("span", { class: "n" }, String(s.n)), h("span", { class: "job" }, `tasks · ${s.pass_rate === null ? "no run" : `${s.pass_rate}% pass`}`), h("span", { class: "chips" }, s.broken ? h("span", { class: "pill bad" }, `${s.broken} broken`) : null, s.flaky ? h("span", { class: "pill warn" }, `${s.flaky} flaky`) : null, s.graduate ? h("span", { class: "pill blue" }, `${s.graduate} ready to graduate`) : null, s.gate?.report_only ? h("span", { class: "pill" }, "report only") : null))));
  const rows = d.tasks.filter((t) => t.suite === suite && (!tasksPage.filter || t.id.includes(tasksPage.filter) || (t.description ?? "").includes(tasksPage.filter)) && (!tasksPage.mode || t.checks.some((c) => c.failure_mode === tasksPage.mode)));
  const modes = [...new Set(d.tasks.flatMap((t) => t.checks.map((c) => c.failure_mode)).filter(Boolean))].sort();
  const pill = (st) => h("span", { class: `pill ${st === "passing" ? "good" : st === "broken" || st === "failing" ? "bad" : st === "flaky" || st === "mixed" ? "warn" : st === "graduate" ? "blue" : ""}` }, st === "graduate" ? "Ready to graduate" : st === "no runs" ? "No runs" : st[0].toUpperCase() + st.slice(1));
  const hist = (t) => h("span", { class: "hist", role: "img", "aria-label": t.history.map((x) => (x ? `${x.passed} of ${x.trials}` : "not run")).join(", ") }, ...t.history.map((x) => h("span", { class: !x ? "none" : x.trials && x.passed === x.trials ? "" : x.passed === 0 ? "fail" : "mixed" })));
  const sel = d.suites.find((s) => s.name === suite);
  const table = h("section", { class: "card", "aria-label": "Task table" },
    h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, `${suite ? suite[0].toUpperCase() + suite.slice(1) : "All"} · ${rows.length} tasks`), h("div", { class: "two-col", style: "gap:8px" }, h("input", { class: "text", placeholder: "Filter by id or description", "aria-label": "Filter", value: tasksPage.filter, oninput: (e) => { tasksPage.filter = e.target.value; renderTasks(suite); } }), h("select", { class: "select", "aria-label": "Failure mode", onchange: (e) => { tasksPage.mode = e.target.value; renderTasks(suite); } }, h("option", { value: "" }, "All failure modes"), ...modes.map((m) => h("option", { value: m, selected: m === tasksPage.mode }, m))))),
    h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Task"), h("th", { scope: "col" }, "Source"), h("th", { scope: "col" }, "Checks"), h("th", { scope: "col", style: "text-align:right" }, "pass@1"), h("th", { scope: "col", style: "text-align:right" }, "pass^k"), h("th", { scope: "col" }, "Last 5 runs"), h("th", { scope: "col" }, "Status"))), h("tbody", {}, ...rows.map((t) => h("tr", {}, h("td", {}, h("a", { class: "mono", href: `#/tasks/${encodeURIComponent(suite)}/${encodeURIComponent(t.id)}` }, t.id), t.description ? h("span", { class: "desc" }, t.description) : null), h("td", { class: "mono", style: "font-weight:400;font-size:12px" }, t.source), h("td", { style: "font-size:12px" }, t.checks.map((c) => c.type[0].toUpperCase()).join(" ") + ` · ${t.checks.length}`), h("td", { class: "num" }, t.pass_at_1 === null ? "—" : `${t.pass_at_1}%`), h("td", { class: "num" }, t.pass_hat_k === null ? "—" : `${t.pass_hat_k}%`), h("td", {}, hist(t)), h("td", {}, pill(t.status)))))),
    h("span", { class: "caption muted" }, "Checks: O outcome, C code, J judge, T transcript. A task at 0% across every trial in three runs is marked broken: check its spec and reference solution before blaming the agent."));
  const ready = d.proposals.filter((p) => !suite || p.from === suite);
  page.replaceChildren(h("div", { class: "column" },
    h("header", { class: "page-header" }, h("div", { class: "titles" }, h("h1", { class: "t-page-title" }, "Tasks & suites"), h("p", { class: "subtitle" }, `${d.tasks.length} tasks in ${d.suites.length} suites · every task has a reference solution that passes its checks`)), h("div", { class: "verdict" }, h("a", { class: "btn", href: "#/review" }, "Promote from review queue"))),
    cards,
    h("section", { class: "card", "aria-label": "Health" }, h("div", { class: "health" }, h("span", { class: "eyebrow" }, "Suite health"), h("span", {}, `${d.tasks.filter((t) => t.status === "broken").length} likely broken`), h("span", {}, `${d.tasks.filter((t) => t.status === "flaky").length} flaky`), h("span", {}, `${d.proposals.length} ready to graduate`), h("span", {}, `Balance: ${d.balance_should_pct}% should / ${100 - d.balance_should_pct}% shouldn't`), ...d.saturation.map((s) => h("span", { class: "pill warn" }, `${s.suite} saturating at ${s.pass_rate}%`)), ready.length ? h("button", { type: "button", class: "linklike", onclick: () => graduate(ready.map((p) => p.task)) }, `Graduate ${ready.length} task${ready.length > 1 ? "s" : ""}`) : null, status)),
    table));
  void sel;
}

async function renderTaskEditor(d, taskId) {
  const page = $("#page"); const t = d.tasks.find((x) => x.id === taskId);
  if (!t) { page.replaceChildren(h("div", { class: "column" }, header("Task not found", taskId))); return; }
  const file = await api(`/api/file?path=${encodeURIComponent(t.path)}`);
  const refPath = file.data?.reference_solution; const ref = refPath ? await api(`/api/file?path=${encodeURIComponent(refPath)}`).catch(() => null) : null;
  const stateEl = h("span", { class: "save-state", "aria-live": "polite" }, "Saved · in sync with disk");
  let yamlText = file.content; let refText = ref?.content ?? "";
  const yamlEl = h("textarea", { class: "note prompt", "aria-label": "Task file", oninput: (e) => { yamlText = e.target.value; stateEl.textContent = "Not saved · edited"; stateEl.className = "save-state"; } }, yamlText);
  const refEl = h("textarea", { class: "note prompt", "aria-label": "Reference solution", style: "min-height:180px", oninput: (e) => { refText = e.target.value; stateEl.textContent = "Not saved · edited"; stateEl.className = "save-state"; } }, refText);
  const save = async () => { try { if (yamlText !== file.content) await api("/api/file", { method: "PUT", body: JSON.stringify({ path: t.path, content: yamlText, base_hash: file.hash }) }); if (ref && refText !== ref.content) await api("/api/file", { method: "PUT", body: JSON.stringify({ path: refPath, content: refText, base_hash: ref.hash }) }); stateEl.textContent = `Checked and saved to branch · ${new Date().toLocaleTimeString()}`; stateEl.className = "save-state good"; await refreshHealth(); renderTasks(t.suite, taskId); } catch (e) { stateEl.textContent = e.status === 409 ? "Not saved · conflict (reload the page to see the disk version)" : `Not saved · ${e.body?.problems?.[0]?.message ?? e.message}`; stateEl.className = "save-state bad"; } };
  const move = async () => { const to = prompt("Move to which suite?", t.suite === "capability" ? "regression" : t.suite); if (!to || to === t.suite || !d.suites.some((s) => s.name === to)) return; try { await api("/api/graduate", { method: "POST", body: JSON.stringify({ tasks: [t.id] }) }); await refreshHealth(); location.hash = `#/tasks/${encodeURIComponent(to)}/${encodeURIComponent(t.id)}`; } catch (e) { stateEl.textContent = e.message; stateEl.className = "save-state bad"; } };
  page.replaceChildren(h("div", { class: "column" },
    h("header", { class: "page-header" }, h("div", { class: "titles" }, h("nav", { class: "breadcrumb", "aria-label": "Breadcrumb" }, h("a", { href: "#/tasks" }, "Tasks & suites"), h("span", { class: "sep" }, "/"), h("a", { href: `#/tasks/${encodeURIComponent(t.suite)}` }, t.suite), h("span", { class: "sep" }, "/"), h("span", { class: "mono" }, t.id)), h("div", { class: "title-row" }, h("h1", { class: "t-page-title mono" }, t.id), h("span", { class: "pill" }, t.source)), h("p", { class: "subtitle" }, t.description ?? "", ` · ${t.checks.length} checks · ${t.trials ?? "config"} trials${t.graduated_from ? ` · graduated from ${t.graduated_from}` : ""}`)), h("div", { class: "verdict" }, t.history.some(Boolean) ? h("a", { class: "btn", href: `#/transcripts/${encodeURIComponent(t.history.filter(Boolean).slice(-1)[0].run)}/${encodeURIComponent(t.id)}/1` }, "Latest transcript") : null, h("button", { type: "button", class: "btn", onclick: move }, t.suite === "capability" ? "Graduate to regression" : "Move to another suite"))),
    h("div", { class: "two-col" },
      h("section", { class: "card main", "aria-label": "Task spec" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Task file"), stateEl), h("label", { class: "field" }, h("span", { class: "mono", style: "font-weight:400;font-size:12px" }, `evals/${t.path}`), yamlEl), ref ? h("label", { class: "field" }, h("span", { class: "mono", style: "font-weight:400;font-size:12px" }, `evals/${refPath} · must pass every check`), refEl) : null, h("div", { class: "verdict" }, h("button", { type: "button", class: "btn primary", onclick: save }, "Save"), h("span", { class: "caption muted", style: "align-self:center" }, "Saved files are validated against their schema and the cross-file rules; a reference that fails a check is refused by litmustest validate --deep."))),
      h("section", { class: "card side", "aria-label": "History" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Last 5 runs")), ...(t.history.some(Boolean) ? t.history.map((x, i) => x ? h("div", { class: "cluster-row", style: "grid-template-columns:minmax(0,1fr) 70px 60px" }, h("a", { class: "mono", href: `#/transcripts/${encodeURIComponent(x.run)}/${encodeURIComponent(t.id)}/1` }, x.run), h("span", { class: "frac" }, `${x.passed} / ${x.trials}`), h("span", { class: `pill ${x.likely_broken ? "bad" : x.flaky ? "warn" : x.passed === x.trials ? "good" : "bad"}` }, x.likely_broken ? "Broken" : x.flaky ? "Flaky" : x.passed === x.trials ? "Pass" : "Fail")) : h("div", { class: "cluster-row" }, h("span", { class: "muted" }, `${d.runs[i]} · not run`))) : [h("p", { class: "muted", style: "margin:0" }, "No runs include this task yet.")]),
        h("div", { class: "card-head", style: "margin-top:8px" }, h("h2", { class: "t-section-title" }, "Checks")), ...t.checks.map((c) => h("div", { class: "lint ok" }, h("span", { class: "mark", "aria-hidden": "true" }, c.type[0].toUpperCase()), h("span", { class: "mono", style: "font-weight:400" }, c.id), h("span", { class: "caption muted" }, `${c.type}${c.failure_mode ? ` · ${c.failure_mode}` : ""} · w${c.weight}`)))))));
}

// ---------------- settings
const settingsPage = { mode: "form" };
async function renderSettings() {
  const seq = state.seq; const page = $("#page");
  const file = await api("/api/file?path=litmustest.yaml"); if (stale(seq)) return;
  const cfg = JSON.parse(JSON.stringify(file.data)); let yamlText = file.content;
  const stateEl = h("span", { class: "save-state", "aria-live": "polite" }, "Saved · in sync with disk");
  const dirty = () => { stateEl.textContent = "Not saved · edited"; stateEl.className = "save-state"; };
  const num = (obj, key, label, opts = {}) => h("label", { class: "field" }, h("span", {}, label), h("input", { class: "text", type: "number", step: opts.step ?? 1, min: opts.min ?? 0, value: obj[key] ?? "", placeholder: opts.placeholder ?? "", oninput: (e) => { const v = e.target.value; if (v === "") delete obj[key]; else obj[key] = Number(v); dirty(); } }));
  const text = (obj, key, label, placeholder = "") => h("label", { class: "field" }, h("span", {}, label), h("input", { class: "text", value: obj[key] ?? "", placeholder, oninput: (e) => { obj[key] = e.target.value; dirty(); } }));
  const check = (obj, key, label, dflt = true) => h("label", { class: "checkline" }, h("input", { type: "checkbox", checked: obj[key] ?? dflt, onchange: (e) => { obj[key] = e.target.checked; dirty(); } }), h("span", {}, label));
  const select = (obj, key, label, options) => h("label", { class: "field" }, h("span", {}, label), h("select", { class: "select", onchange: (e) => { obj[key] = e.target.value; dirty(); } }, ...options.map(([v, l]) => h("option", { value: v, selected: (obj[key] ?? options[0][0]) === v }, l))));
  cfg.gates ??= {}; cfg.runs ??= {}; cfg.judges ??= {}; cfg.ci ??= {}; cfg.sources ??= { traces: { format: "jsonl", path: "" } }; cfg.sources.sampler ??= {}; cfg.storage ??= {}; cfg.storage.transcripts ??= { backend: "local" }; cfg.agent ??= { command: "" };
  const suites = [...new Set([...Object.keys(cfg.gates), ...state.modes.length ? [] : [], ...(await api("/api/tasks").catch(() => ({ suites: [] }))).suites.map((s) => s.name)])];
  for (const s of suites) cfg.gates[s] ??= {};
  const form = h("div", { style: "display:flex;flex-direction:column;gap:12px" },
    h("section", { class: "card", "aria-label": "CI gates" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "CI gates"), h("span", { class: "caption" }, "What blocks a pull request. A gate compares against the base branch's last run, paired.")), ...suites.map((s) => h("div", { class: "gate-row" }, h("span", { class: "mono" }, s), h("label", { class: "checkline" }, h("input", { type: "checkbox", checked: Boolean(cfg.gates[s].report_only), onchange: (e) => { cfg.gates[s].report_only = e.target.checked; dirty(); } }), h("span", {}, "report only")), num(cfg.gates[s], "min_pass_rate", "Minimum pass rate", { placeholder: "none", max: 100 }), num(cfg.gates[s], "max_drop_pts", "Max drop vs base (pts)", { placeholder: "none", step: 0.5 }))), ...suites.map((s) => check(cfg.gates[s], "trusted_judges_only", `${s}: only trusted judges count`)), check(cfg.ci, "pr_comment", "Post the comparison as a pull request comment")),
    h("section", { class: "card", "aria-label": "Runs" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Runs")), h("div", { class: "settings-grid" }, num(cfg.runs, "trials", "Trials per task", { min: 1 }), num(cfg.runs, "concurrency", "Concurrency", { min: 1 }), num(cfg.runs, "budget_usd", "Budget per run ($)", { step: 0.5 }), select(cfg.runs, "environment", "Environment", [["inprocess", "In process (agent.command per trial)"], ["docker", "Container per trial (docker) · not implemented"], ["harbor", "Container per trial (Harbor) · not implemented"]])), h("div", { class: "settings-grid" }, num(cfg.runs.resources ??= {}, "timeout_s", "Timeout per trial (s)", { min: 1 }), num(cfg.runs.resources, "cpus", "CPUs", { step: 0.5 }), num(cfg.runs.resources, "memory_mb", "Memory (MB)", { min: 128 })), text(cfg.agent, "command", "Agent command (runs once per trial; placeholders {task} {task_file} {trial_dir} {trial} {evals})", "node agent.mjs --task {task} --out {trial_dir}"), h("span", { class: "caption muted" }, "Infra errors are tagged and excluded from agent scores.")),
    h("section", { class: "card", "aria-label": "Judges" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Judges")), h("div", { class: "settings-grid" }, text(cfg.judges, "default_model", "Default judge model (pinned)"), num(cfg.judges, "trust_threshold", "Trust threshold (TPR and TNR, %)", { min: 50, max: 100 })), check(cfg.judges, "stale_on_change", "Mark a judge stale when its prompt or model changes"), check(cfg.judges, "correct_for_judge_error", "Correct reported pass rates for judge error")),
    h("section", { class: "card", "aria-label": "Sources and storage" }, h("div", { class: "card-head" }, h("h2", { class: "t-section-title" }, "Sources and storage")), h("div", { class: "settings-grid" }, select(cfg.sources.traces, "format", "Trace source", [["jsonl", "JSONL file"], ["otel", "OpenTelemetry JSON"], ["langfuse", "Langfuse (pull)"], ["braintrust", "Braintrust (pull)"], ["langsmith", "LangSmith · adapter pending"]]), text(cfg.sources.traces, "path", "Path or glob (file sources)"), text(cfg.sources.traces, "project", "Project id (Braintrust)")), h("div", { class: "settings-grid" }, select(cfg.sources.sampler, "every", "Production sampler", [["manual", "Manual"], ["daily", "Daily"], ["weekly", "Weekly"]]), num(cfg.sources.sampler, "size", "Traces per batch", { min: 1 }), num(cfg.sources.sampler, "clusters", "Clusters", { min: 1 })), h("div", { class: "settings-grid" }, text(cfg.storage, "summaries", "Run summaries (git)", "evals/runs"), select(cfg.storage.transcripts, "backend", "Raw transcripts", [["local", "Local, git-ignored"], ["s3", "S3 bucket"], ["gcs", "GCS bucket"], ["braintrust", "Braintrust"], ["langfuse", "Langfuse"], ["langsmith", "LangSmith"]]), text(cfg.storage.transcripts, "path", "Path or bucket", ".litmustest/transcripts")), h("span", { class: "caption muted" }, "Credentials never go in this file: Langfuse and Braintrust read LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST and BRAINTRUST_API_KEY from the environment.")));
  const yamlEl = h("textarea", { class: "note prompt", "aria-label": "litmustest.yaml", style: "min-height:460px", oninput: (e) => { yamlText = e.target.value; dirty(); } }, yamlText);
  const save = async () => { try { const clean = (o) => { for (const k of Object.keys(o)) { if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) { clean(o[k]); if (!Object.keys(o[k]).length) delete o[k]; } else if (o[k] === "" || o[k] === undefined) delete o[k]; } return o; }; const body = settingsPage.mode === "form" ? { path: "litmustest.yaml", data: clean(JSON.parse(JSON.stringify(cfg))), base_hash: file.hash } : { path: "litmustest.yaml", content: yamlText, base_hash: file.hash }; await api("/api/file", { method: "PUT", body: JSON.stringify(body) }); stateEl.textContent = `Checked and saved to branch · ${new Date().toLocaleTimeString()}`; stateEl.className = "save-state good"; await refreshHealth(); renderSettings(); } catch (e) { stateEl.textContent = e.status === 409 ? "Not saved · conflict (reload to see the disk version)" : `Not saved · ${e.body?.problems?.[0]?.message ?? e.message}`; stateEl.className = "save-state bad"; } };
  page.replaceChildren(h("div", { class: "column" },
    h("header", { class: "page-header" }, h("div", { class: "titles" }, h("h1", { class: "t-page-title" }, "Settings"), h("p", { class: "subtitle" }, "Everything here is ", h("span", { class: "mono" }, "evals/litmustest.yaml"), ". Edit the form or the file; they stay in step.")), h("div", { class: "toggle", role: "group", "aria-label": "Editor mode" }, h("button", { type: "button", "aria-pressed": settingsPage.mode === "form" ? "true" : "false", onclick: () => { settingsPage.mode = "form"; renderSettings(); } }, "Form"), h("button", { type: "button", "aria-pressed": settingsPage.mode === "yaml" ? "true" : "false", onclick: () => { settingsPage.mode = "yaml"; renderSettings(); } }, "litmustest.yaml"))),
    settingsPage.mode === "form" ? form : h("section", { class: "card", "aria-label": "File" }, yamlEl),
    h("div", { class: "save-row" }, h("button", { type: "button", class: "btn primary", onclick: save }, "Save"), h("span", { class: "caption muted" }, "Changes save to litmustest.yaml on your branch after validation."), stateEl)));
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
      case "compare": await renderCompare(state.route[1], state.route[2]); break;
      case "tasks": await renderTasks(state.route[1], state.route[2]); break;
      case "settings": await renderSettings(); break;
      case "transcripts": if (state.route[3]) await renderTrial(state.route[1], state.route[2], Number(state.route[3])); else await renderTranscripts(state.route[1]); break;
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
