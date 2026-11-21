// litmustest dashboard: palette.js. ⌘K search (design/mockups/v2/CommandP): jump to a place, a task, a failure mode, a
// judge or a run. Everything is matched in the browser from the read routes the screens already use; nothing is written.
import { $, api, h } from "./lib/dom.js";
import { state } from "./lib/state.js";

const enc = encodeURIComponent;
const pal = { open: false, items: null, q: "", sel: 0, opener: null, loading: null };

const PLACES = [
  ["Home", "#/home", "The verdict and Up next"], ["Ship", "#/ship", "Is this change safe to merge?"], ["Decide who's right", "#/ship/decide", "Ship"],
  ["Label", "#/teach/label", "Teach · step 1"], ["Group notes", "#/teach/group", "Teach · step 2"], ["Failure modes", "#/teach/modes", "Teach · step 3"], ["Trust judges", "#/teach/judges", "Teach · step 4"],
  ["Cover", "#/cover", "What isn't tested"], ["Tasks and suites", "#/cover/tasks", "Cover"], ["Set up coverage", "#/cover/setup", "Cover"],
  ["Runs and trials", "#/library/runs", "Library"], ["Settings", "#/library/settings", "Library"], ["Pending changes", "#/pending", "What is waiting to be committed"],
];

/** The index: built once per open from the read routes, so a file changed since the last open is found. */
async function load() {
  const [tasks, judges, runs] = await Promise.all([api("/api/tasks").catch(() => ({ tasks: [] })), api("/api/judges").catch(() => ({ judges: [] })), api("/api/runs").catch(() => ({ runs: [] }))]);
  return [
    ...PLACES.map(([label, href, sub]) => ({ kind: "Places", label, href, sub })),
    ...(state.modes ?? []).filter((m) => !m.retired).map((m) => ({ kind: "Failure modes", label: m.name, href: `#/teach/modes/${enc(m.name)}`, sub: m.severity ? `severity ${m.severity}` : "", mono: true })),
    ...judges.judges.map((j) => ({ kind: "Judges", label: j.name, href: `#/teach/judges/${enc(j.name)}`, sub: j.status, mono: true })),
    ...tasks.tasks.map((t) => ({ kind: "Tasks", label: t.id, href: `#/cover/tasks/${enc(t.suite)}/${enc(t.id)}`, sub: t.suite, mono: true })),
    ...runs.runs.map((r) => ({ kind: "Runs", label: r.run_id, href: `#/library/runs/${enc(r.run_id)}`, sub: [r.branch, r.started_at ? new Date(r.started_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""].filter(Boolean).join(" · "), mono: true })),
  ];
}

/** Subsequence match with a bonus for word starts and a run of consecutive letters; null when the query does not fit. */
export function score(text, q) {
  const t = text.toLowerCase(); const s = q.toLowerCase().replace(/\s+/g, "");
  if (!s) return 0;
  const at = t.indexOf(s); if (at >= 0) return 100 - at + (at === 0 || /[\s_/-]/.test(t[at - 1]) ? 50 : 0);
  let i = 0, total = 0, run = 0;
  for (let j = 0; j < t.length && i < s.length; j++) {
    if (t[j] === s[i]) { run++; total += 1 + run + (j === 0 || /[\s_/-]/.test(t[j - 1]) ? 5 : 0); i++; } else run = 0;
  }
  return i === s.length ? total : null;
}

function results() {
  const q = pal.q.trim();
  const scored = (pal.items ?? []).map((x) => ({ x, s: q ? Math.max(score(x.label, q) ?? -1, (score(x.sub ?? "", q) ?? -1) - 40) : 0 })).filter((r) => r.s >= 0);
  if (q) scored.sort((a, b) => b.s - a.s);
  const groups = new Map();
  for (const { x } of scored) { const g = groups.get(x.kind) ?? []; if (g.length < (q ? 6 : x.kind === "Places" ? 13 : 4)) g.push(x); groups.set(x.kind, g); }
  return [...groups.entries()];
}

function render() {
  const box = $("#palette"); if (!box) return;
  const groups = results(); const flat = groups.flatMap(([, xs]) => xs);
  pal.sel = Math.max(0, Math.min(pal.sel, flat.length - 1));
  const list = $("#palette-list");
  let n = -1;
  list.replaceChildren(...(pal.items === null ? [h("p", { class: "pal-empty" }, "Loading…")] : flat.length ? groups.map(([kind, xs]) => h("div", { role: "group", "aria-label": kind, class: "pal-group" },
    h("span", { class: "pal-kind", "aria-hidden": "true" }, kind),
    ...xs.map((x) => { n++; const i = n; return h("a", { role: "option", id: `pal-opt-${i}`, href: x.href, class: "pal-item", "aria-selected": i === pal.sel ? "true" : "false", onmousemove: () => { if (pal.sel !== i) { pal.sel = i; render(); } }, onclick: () => close(false) },
      h("span", { class: x.mono ? "pal-label mono" : "pal-label" }, x.label), x.sub ? h("span", { class: "pal-sub" }, x.sub) : null); })))
    : [h("p", { class: "pal-empty" }, `Nothing matches “${pal.q}”.`)]));
  const input = $("#palette-input");
  if (flat.length) input.setAttribute("aria-activedescendant", `pal-opt-${pal.sel}`); else input.removeAttribute("aria-activedescendant");
  $(`#pal-opt-${pal.sel}`)?.scrollIntoView({ block: "nearest" });
}

export async function openPalette(opener) {
  if (pal.open) return;
  pal.open = true; pal.q = ""; pal.sel = 0; pal.items = null; pal.opener = opener ?? document.activeElement;
  const input = h("input", { id: "palette-input", class: "pal-input", type: "text", role: "combobox", "aria-expanded": "true", "aria-controls": "palette-list", "aria-autocomplete": "list", "aria-label": "Search or jump to", placeholder: "Search tasks, failure modes, judges, runs or a place…", autocomplete: "off", spellcheck: "false",
    oninput: (e) => { pal.q = e.target.value; pal.sel = 0; render(); } });
  const dialog = h("div", { id: "palette", class: "palette", role: "dialog", "aria-modal": "true", "aria-label": "Search or jump to" },
    h("div", { class: "pal-panel" },
      h("div", { class: "pal-head" }, input, h("kbd", {}, "esc")),
      h("div", { id: "palette-list", class: "pal-list", role: "listbox", "aria-label": "Results" }),
      h("p", { class: "pal-foot" }, h("kbd", {}, "↑"), h("kbd", {}, "↓"), " to move · ", h("kbd", {}, "↵"), " to open · ", h("kbd", {}, "esc"), " to close")));
  dialog.addEventListener("mousedown", (e) => { if (e.target === dialog) close(true); });
  document.body.append(dialog); input.focus(); render();
  pal.loading = load().then((items) => { pal.items = items; if (pal.open) render(); }).catch(() => { pal.items = PLACES.map(([label, href, sub]) => ({ kind: "Places", label, href, sub })); render(); });
}

export function close(restore = true) {
  if (!pal.open) return;
  pal.open = false; $("#palette")?.remove();
  if (restore) pal.opener?.focus?.();
}

function go() {
  const flat = results().flatMap(([, xs]) => xs); const x = flat[pal.sel]; if (!x) return;
  close(false); location.hash = x.href;
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); e.stopPropagation(); if (pal.open) close(true); else openPalette(); return; }
  if (!pal.open) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
  else if (e.key === "ArrowDown") { e.preventDefault(); pal.sel++; render(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); pal.sel = Math.max(0, pal.sel - 1); render(); }
  else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); go(); }
  else if (e.key === "Tab") { e.preventDefault(); $("#palette-input")?.focus(); } // focus stays in the dialog
}, true);
