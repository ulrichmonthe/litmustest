// litmustest dashboard: screens/discover.js. Teach step 2, Group notes (design/mockups/v2/DiscoverP, DiscoverNoKeyP).
// Two ways in: Claude proposes failure modes from the notes (litmustest discover; nothing is saved until you accept),
// or a person groups notes by hand. Both write failure-mode files through validated writes into Pending changes.
// Opening the page never calls the model: that waits for the button.
import { teachHead, teachRail } from "../components.js";
import { term } from "../explainer.js";
import { $, api, h } from "../lib/dom.js";
import { stale, state } from "../lib/state.js";
import { refreshHealth } from "../shell.js";

export const disc = { result: null, batch: null, chosen: new Set(), busy: false, error: "", tab: null, picked: new Set(), all: false, more: false, status: "", statusCls: "status" };
const enc = encodeURIComponent;

function claudeTab(batchName, rerender) {
  const r = disc.result; const key = Boolean(state.health?.model_key);
  const run = async () => { disc.busy = true; disc.error = ""; disc.result = null; rerender(); try { disc.result = await api("/api/discover", { method: "POST", body: JSON.stringify({ batch: batchName || undefined }) }); disc.chosen = new Set(disc.result.proposals.map((p) => p.path)); } catch (e) { disc.error = e.message; } disc.busy = false; rerender(); };
  const status = h("span", { class: "status", "aria-live": "polite" });
  const accept = async () => {
    const picked = r.proposals.filter((p) => disc.chosen.has(p.path)); let ok = 0; const fails = [];
    for (const p of picked) { try { await api("/api/file", { method: "PUT", body: JSON.stringify({ path: p.path, content: p.content }) }); ok++; } catch (e) { fails.push(`${p.name}: ${e.body?.problems?.[0]?.message ?? e.message}`); } }
    await refreshHealth();
    disc.status = `${ok} file${ok === 1 ? "" : "s"} saved to Pending changes${fails.length ? `; refused: ${fails.join("; ")}` : ""}`; disc.statusCls = fails.length ? "status bad" : "status good";
    disc.result = { ...r, proposals: r.proposals.filter((p) => !disc.chosen.has(p.path) || fails.some((f) => f.startsWith(p.name + ":"))) }; rerender();
  };
  if (!key && !r) return h("div", { class: "empty-quiet" }, "Claude needs a model key to propose groups: set ", h("span", { class: "mono" }, "ANTHROPIC_API_KEY"), " in the shell that runs ", h("span", { class: "mono" }, "litmustest serve"), ". Until then, ", h("button", { type: "button", class: "linklike", onclick: () => { disc.tab = "hand"; rerender(); } }, "group them by hand"), ".");
  if (disc.busy) return h("div", { class: "empty-quiet" }, "Claude is reading your notes… this takes about half a minute.");
  if (disc.error) return h("div", {}, h("p", { class: "status bad" }, disc.error), h("button", { type: "button", class: "btn", onclick: run }, "Try again"));
  if (!r) return h("div", { class: "proposals-empty" }, h("p", {}, "Claude reads the notes", batchName ? [" from batch ", h("span", { class: "mono" }, batchName)] : "", " and proposes failure modes: new ones, merges into ones you have, and notes that fit an existing mode. Your notes are never changed, and nothing is saved until you accept."), h("button", { type: "button", class: "btn primary", onclick: run }, "Ask Claude to group the notes"));
  const card = (p) => h("label", { class: "proposal" },
    h("input", { type: "checkbox", checked: disc.chosen.has(p.path), onchange: (e) => { e.target.checked ? disc.chosen.add(p.path) : disc.chosen.delete(p.path); } }),
    h("span", { class: "proposal-body" },
      h("span", { class: "proposal-head" }, h("span", { class: "eyebrow" }, p.action === "create" ? "New failure mode" : p.action === "retire" ? "Retire" : p.merged_into ? `Merge into ${p.merged_into}` : "Update"), h("span", { class: "mono" }, p.name)),
      p.definition ? h("span", { class: "proposal-def" }, p.definition) : null,
      p.rationale ? h("span", { class: "caption muted" }, p.rationale) : null,
      p.examples?.length ? h("span", { class: "caption muted" }, `${p.examples.length} ${p.examples.length === 1 ? "conversation" : "conversations"} as examples`) : null));
  return h("div", { class: "claude-tab" },
    h("p", { class: "caption muted" }, `${r.proposals.length} proposed ${r.proposals.length === 1 ? "change" : "changes"} from ${r.notes_used} notes on ${r.traces_used} conversations · model `, h("span", { class: "mono" }, r.model), r.unassigned.length ? ` · ${r.unassigned.length} notes fit no mode` : ""),
    r.proposals.length ? h("div", { class: "proposals", "aria-label": "Proposals" }, ...r.proposals.map(card)) : h("p", { class: "empty-quiet" }, "Nothing to change: your failure modes already cover every note."),
    h("div", { class: "home-actions" }, h("button", { type: "button", class: "btn primary", disabled: !r.proposals.length, onclick: accept }, "Accept selected"), h("button", { type: "button", class: "btn quiet", onclick: run }, "Ask again"), h("a", { class: "btn quiet", href: "#/pending" }, "Open Pending changes"), status));
}

async function handTab(rerender) {
  const d = await api("/api/teach/notes");
  const shown = disc.all ? d.notes : d.notes.filter((n) => !n.tagged);
  const visible = disc.more ? shown : shown.slice(0, 20);
  const picked = [...disc.picked].filter((t) => d.notes.some((n) => n.trace_id === t));
  const save = async (body, label) => {
    disc.status = "Saving…"; disc.statusCls = "status"; rerender();
    try { const r = await api("/api/modes/notes", { method: "POST", body: JSON.stringify({ ...body, traces: picked }) }); await refreshHealth(); disc.picked.clear(); disc.status = `${label}: ${r.path} is in Pending changes.`; disc.statusCls = "status good"; }
    catch (e) { disc.status = `Not saved · ${e.body?.problems?.[0]?.message ?? e.message}`; disc.statusCls = "status bad"; }
    rerender();
  };
  const name = h("input", { class: "text mono", id: "new-mode-name", placeholder: "snake_case_name", "aria-label": "New failure mode name" });
  const def = h("textarea", { class: "text", id: "new-mode-def", rows: 3, placeholder: "Fail when …", "aria-label": "Definition" });
  const sev = h("select", { class: "select", "aria-label": "Severity" }, ...["high", "med", "low"].map((x) => h("option", { value: x, selected: x === "med" }, x)));
  const note = (n) => h("button", { type: "button", class: "note-row", "aria-pressed": disc.picked.has(n.trace_id) ? "true" : "false", onclick: () => { disc.picked.has(n.trace_id) ? disc.picked.delete(n.trace_id) : disc.picked.add(n.trace_id); rerender(); } },
    h("span", { class: "note-check", "aria-hidden": "true" }, disc.picked.has(n.trace_id) ? "✓" : ""),
    h("span", { class: "note-text" }, `“${n.note}”`, h("span", { class: "caption muted" }, h("span", { class: "mono" }, n.trace_id), n.tagged ? [" · tagged ", h("span", { class: "mono" }, n.failure_mode)] : " · in no failure mode")));
  return h("div", { class: "hand-tab" },
    h("div", { class: "hand-notes" },
      h("div", { class: "section-head" }, h("h2", {}, disc.all ? "All notes on failures" : "Notes in no failure mode"), h("label", { class: "inline-check" }, h("input", { type: "checkbox", checked: disc.all, onchange: (e) => { disc.all = e.target.checked; rerender(); } }), "Show tagged notes too")),
      shown.length ? h("div", { class: "note-list", role: "group", "aria-label": "Notes" }, ...visible.map(note)) : h("p", { class: "empty-quiet" }, d.notes.length ? "Every note is already tagged with a failure mode. Tick the box to add tagged notes to a mode as examples." : "No notes on failures yet. Label conversations first and say what went wrong in your own words."),
      shown.length > visible.length ? h("button", { type: "button", class: "linklike", onclick: () => { disc.more = true; rerender(); } }, `Show all ${shown.length}`) : null),
    h("aside", { class: "hand-side", "aria-label": "Group the picked notes" },
      h("p", { class: "label" }, picked.length ? `${picked.length} ${picked.length === 1 ? "note" : "notes"} picked` : "Pick notes that describe the same problem"),
      h("div", { class: "mode-targets" }, ...d.modes.map((m) => h("button", { type: "button", class: "btn mode-target", disabled: !picked.length, onclick: () => save({ mode: m.name }, `Added to ${m.name}`) }, h("span", { class: "mono" }, m.name), h("span", { class: "muted" }, `${m.labels} labels`)))),
      h("div", { class: "new-mode" }, h("p", { class: "label" }, "Or a new ", term("failure_mode", "failure mode")), name, def, h("label", { class: "inline-check" }, "Severity ", sev),
        h("button", { type: "button", class: "btn primary", disabled: !picked.length, onclick: () => { if (!name.value.trim() || !def.value.trim()) { disc.status = "A new failure mode needs a name and a definition."; disc.statusCls = "status bad"; rerender(); return; } save({ create: { name: name.value.trim(), definition: def.value.trim(), severity: sev.value } }, `Created ${name.value.trim()}`); } }, picked.length ? `Create with ${picked.length} ${picked.length === 1 ? "note" : "notes"}` : "Create")),
      h("p", { class: "caption muted" }, "A note's conversation becomes an example of the failure mode. Each change lands in Pending changes; your notes are never changed.")));
}

export async function renderDiscover(batchName) {
  const seq = state.seq; const page = $("#page");
  if (disc.batch !== batchName) { disc.batch = batchName; disc.result = null; disc.picked.clear(); }
  if (!disc.tab) disc.tab = state.health?.model_key || disc.result ? "claude" : "hand";
  const rerender = () => { if (!stale(seq)) renderDiscover(batchName); };
  const tab = (key, label) => h("button", { type: "button", role: "tab", "aria-selected": disc.tab === key ? "true" : "false", onclick: () => { disc.tab = key; disc.status = ""; rerender(); } }, label);
  const body = disc.tab === "claude" ? claudeTab(batchName, rerender) : await handTab(rerender);
  if (stale(seq)) return;
  page.replaceChildren(h("div", { class: "column" },
    teachRail("group"),
    teachHead("Group your notes into failure modes", ["Name what goes wrong. Each ", term("failure_mode", "failure mode"), " is a file under ", h("span", { class: "mono" }, "evals/failure_modes/"), ", and nothing is saved until it is in Pending changes."]),
    h("div", { class: "seg tabs-seg", role: "tablist", "aria-label": "How to group" }, tab("claude", "Claude proposes"), tab("hand", "By hand")),
    body,
    disc.status ? h("p", { class: disc.statusCls, "aria-live": "polite" }, disc.status) : null,
    h("div", { class: "home-actions" }, h("a", { class: "btn quiet", href: "#/teach/modes" }, "Continue to failure modes"))));
}
