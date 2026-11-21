// litmustest dashboard: screens/coverage.js
import { coverTabs, statusWord } from "../components.js";
import { plain, term } from "../explainer.js";
import { $, api, h } from "../lib/dom.js";
import { stale, state } from "../lib/state.js";
import { refreshHealth } from "../shell.js";

// ---------------- coverage
export const DEPTHS = [["guarded", "Guarded", "A passing regression task: the merge gate protects it."], ["checked", "Checked", "A passing task outside regression."], ["planned", "Planned", "Only capability tasks, or tasks that have not passed."], ["none", "None", "No task covers it."]];
export const covPage = { depth: "", table: false };
export const COV_MAPS = ["spec", "surface", "risk", "traffic", "code", "frontend"];
/** A map's headline share: the covered weight where items differ in size (traces, lines), else items at checked or better. */
export const covShare = (m) => (m.weighted ? pctOf(m.weighted.covered, m.weighted.total) : pctOf(m.totals.checked + m.totals.guarded, m.totals.total));
export const covLabel = (m) => (m.key === "code" ? "Code lines" : m.label);
export const covJob = (m) => { const t = m.totals; return m.key === "traffic" ? `of production use lands on a checked or guarded item · ${t.total} items seen in production` : m.key === "code" ? `of lines ran during the suites · ${m.weighted.covered} of ${m.weighted.total} lines in ${t.total} files` : `checked or guarded · ${t.total - t.none} of ${t.total} have a task`; };
export const pctOf = (n, d) => (d ? Math.round((100 * n) / d) : 0);
export function commonPrefix(names) { if (names.length < 2) return ""; let p = names[0]; for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1); return p.length >= 2 && /[-/_]$/.test(p) ? p : ""; }
export function depthBar(t) {
  return h("div", { class: "depth-bar", role: "img", "aria-label": DEPTHS.map(([k, l]) => `${l} ${t[k]}`).join(", ") }, ...DEPTHS.map(([k, l]) => t[k] ? h("span", { class: `seg ${k}`, style: `flex:${t[k]}`, title: `${l}: ${t[k]} of ${t.total}` }) : null));
}
/** Radar: one axis per area, three nested rings (planned, checked, guarded or better). Needs three areas or more. */
export function radar(map, onPick, selected) {
  const areas = map.areas; const n = areas.length; const size = 520, cx = size / 2, cy = size / 2 + 6, R = 170;
  const prefix = commonPrefix(areas.map((a) => a.name));
  const pt = (i, f) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; return [cx + Math.cos(a) * R * f, cy + Math.sin(a) * R * f]; };
  const ring = (key) => areas.map((a, i) => pt(i, a.total ? a[key] / a.total : 0).map((v) => v.toFixed(1)).join(",")).join(" ");
  const tip = h("div", { class: "radar-tip", hidden: true });
  const svg = h("svg", { viewBox: `-70 0 ${size + 140} ${size + 12}`, class: "radar", role: "img", "aria-label": `${map.label} coverage by area: ${areas.map((a) => `${a.name} ${a.checked} of ${a.total} checked or better`).join("; ")}` },
    ...[0.25, 0.5, 0.75, 1].map((f) => h("polygon", { points: areas.map((_, i) => pt(i, f).join(",")).join(" "), class: "grid" })),
    ...areas.map((_, i) => { const [x, y] = pt(i, 1); return h("line", { x1: cx, y1: cy, x2: x, y2: y, class: "spoke" }); }),
    h("polygon", { points: ring("planned"), class: "ring planned" }), h("polygon", { points: ring("checked"), class: "ring checked" }), h("polygon", { points: ring("guarded"), class: "ring guarded" }),
    ...[0.5, 1].map((f) => h("text", { x: cx + 4, y: cy - R * f + 12, class: "tick" }, `${f * 100}%`)),
    ...areas.map((a, i) => {
      const [x, y] = pt(i, 1.13); const anchor = Math.abs(x - cx) < 12 ? "middle" : x > cx ? "start" : "end";
      const label = a.name.slice(prefix.length) || a.name;
      const show = (e) => { tip.hidden = false; tip.replaceChildren(h("strong", {}, a.name), h("span", {}, `${a.guarded} guarded · ${a.checked} checked or better · ${a.planned} planned or better · of ${a.total}`)); const r = svg.getBoundingClientRect(); tip.style.left = `${(((x + 70) / (size + 140)) * r.width).toFixed(0)}px`; tip.style.top = `${((y / (size + 12)) * r.height).toFixed(0)}px`; };
      return h("g", { class: `axis-hit${selected === a.name ? " on" : ""}`, tabindex: "0", role: "button", "aria-label": `${a.name}: ${a.checked} of ${a.total} checked or better. Show its items.`, onmouseenter: show, onfocus: show, onmouseleave: () => { tip.hidden = true; }, onblur: () => { tip.hidden = true; }, onclick: () => onPick(a.name), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(a.name); } } },
        h("circle", { cx: pt(i, 1)[0], cy: pt(i, 1)[1], r: 14, class: "hit" }),
        h("circle", { cx: pt(i, a.total ? a.checked / a.total : 0)[0], cy: pt(i, a.total ? a.checked / a.total : 0)[1], r: 4, class: "vertex" }),
        h("text", { x, y: y + 4, "text-anchor": anchor, class: "axis-label" }, `${label} ${a.checked}/${a.total}`));
    }));
  return h("div", { class: "radar-wrap" }, svg, tip, prefix ? h("p", { class: "caption muted", style: "margin:0;text-align:center" }, `Areas shown without their common prefix ${prefix}`) : null);
}
export function areaTable(map, onPick) {
  return h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Area"), h("th", { scope: "col", style: "text-align:right" }, "Items"), h("th", { scope: "col", style: "text-align:right" }, "Guarded"), h("th", { scope: "col", style: "text-align:right" }, "Checked or better"), h("th", { scope: "col", style: "text-align:right" }, "Planned or better"))),
    h("tbody", {}, ...map.areas.map((a) => h("tr", {}, h("td", {}, h("button", { type: "button", class: "linklike mono", onclick: () => onPick(a.name) }, a.name)), h("td", { class: "num" }, String(a.total)), h("td", { class: "num" }, String(a.guarded)), h("td", { class: "num" }, `${a.checked} · ${pctOf(a.checked, a.total)}%`), h("td", { class: "num" }, String(a.planned))))));
}
export async function renderCoverage(mapKey, area) {
  const seq = state.seq; const page = $("#page");
  const c = await api("/api/coverage"); if (stale(seq)) return;
  const maps = COV_MAPS.map((k) => c.maps[k]).filter(Boolean);
  const key = mapKey && c.maps[mapKey] ? mapKey : (maps.find((m) => m.configured && m.areas.length >= 3) ?? maps.find((m) => m.configured) ?? maps[0]).key;
  const map = c.maps[key];
  const go = (k, a) => { location.hash = `#/coverage/${k}${a ? `/${encodeURIComponent(a)}` : ""}`; };
  const prev = c.history.length > 1 ? c.history[c.history.length - 2] : null;
  const tile = (m) => {
    const t = m.totals; const covPct = covShare(m);
    const before = prev?.[m.key]; const d = before ? covPct - (before.weighted ? pctOf(before.weighted.covered, before.weighted.total) : pctOf(before.checked + before.guarded, before.total)) : null;
    return h("button", { type: "button", class: "cov-tile", "aria-pressed": m.key === key ? "true" : "false", onclick: () => go(m.key) },
      h("span", { class: "eyebrow" }, covLabel(m)),
      m.configured ? [h("span", { class: "n" }, `${covPct}%`), h("span", { class: "job" }, `${covJob(m)}${d !== null && d !== 0 ? ` · ${d > 0 ? "+" : "−"}${Math.abs(d)} pts vs ${prev.run_id}` : ""}`), depthBar(t)]
        : [h("span", { class: "n muted" }, "–"), h("span", { class: "job", title: m.reason ?? "" }, "Not measured: not set up")]);
  };
  const legend = h("div", { class: "cov-legend" }, ...DEPTHS.map(([k, l, d]) => h("span", { title: d }, h("i", { class: `sw ${k}` }), l)));
  const onPick = (a) => go(key, a === area ? undefined : a);
  const chartCard = h("section", { class: "card", "aria-label": "Coverage by area" },
    h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, `${map.label} by area`), h("div", { class: "caption muted" }, "Each spoke is an area. The darkest ring is guarded, the middle is checked or better, the lightest is planned or better. Click an area to list its items.")),
      h("div", { class: "filter", role: "group", "aria-label": "View" }, h("button", { type: "button", "aria-pressed": covPage.table ? "false" : "true", onclick: () => { covPage.table = false; renderCoverage(key, area); } }, "Chart"), h("button", { type: "button", "aria-pressed": covPage.table ? "true" : "false", onclick: () => { covPage.table = true; renderCoverage(key, area); } }, "Table"))),
    !map.configured ? h("div", { class: "empty" }, map.reason)
      : covPage.table || map.areas.length < 3 ? [map.areas.length < 3 && !covPage.table ? h("p", { class: "caption muted", style: "margin:0" }, "A radar needs three areas or more; showing the table.") : null, areaTable(map, onPick)]
      : [radar(map, onPick, area), legend]);
  const items = map.items.filter((i) => (!area || i.area === area) && (!covPage.depth || i.depth === covPage.depth));
  const pri = (i) => (i.priority ? h("span", { class: `pill ${i.priority === "P0" ? "bad" : i.priority === "P1" ? "warn" : ""}` }, i.priority) : key === "risk" ? h("span", { class: `pill ${i.area === "high" ? "bad" : i.area === "med" ? "warn" : ""}` }, i.area) : null);
  const itemTable = h("section", { class: "card", "aria-label": "Items" },
    h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, `${area ?? "All areas"} · ${items.length} items`), area ? h("button", { type: "button", class: "linklike", onclick: () => go(key) }, "Show all areas") : null),
      h("div", { class: "filter", role: "group", "aria-label": "Depth" }, h("button", { type: "button", "aria-pressed": covPage.depth ? "false" : "true", onclick: () => { covPage.depth = ""; renderCoverage(key, area); } }, "All"), ...DEPTHS.map(([k, l]) => h("button", { type: "button", "aria-pressed": covPage.depth === k ? "true" : "false", onclick: () => { covPage.depth = k; renderCoverage(key, area); } }, l)))),
    items.length ? h("div", { class: "table-scroll" }, h("table", { class: "plain cov-items" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Item"), h("th", { scope: "col" }, "Depth"), h("th", { scope: "col" }, "Covered by"))),
      h("tbody", {}, ...items.map((i) => h("tr", {}, h("td", {}, h("div", { class: "item-id" }, h("span", { class: "mono" }, i.id), pri(i)), i.title ? h("span", { class: "desc" }, i.title) : null),
        h("td", {}, h("span", { class: `pill depth ${i.depth}` }, DEPTHS.find(([k]) => k === i.depth)[1]), i.failing ? h("span", { class: "pill bad", style: "margin-left:6px" }, "Failing") : null),
        h("td", {}, i.tasks.length ? h("ul", { class: "cov-tasks" }, ...i.tasks.map((t) => h("li", {}, h("a", { class: "mono", href: `#/tasks/${encodeURIComponent(t.suite)}/${encodeURIComponent(t.id)}` }, t.id), ` ${t.suite} · ${t.status === "pass" ? "passing" : t.status === "fail" ? "failing" : "not run"} · ${t.via === "called" ? "called it" : t.via === "covers" ? "covers:" : t.via === "source" ? "source" : "checks it"}`, t.note ? h("span", { class: "muted" }, ` · ${t.note}`) : null)))
          : h("span", { class: "muted" }, "No task")))))))
      : h("p", { class: "muted", style: "margin:0" }, map.configured ? "Nothing at this depth." : map.reason));
  const gapList = h("section", { class: "card side", "aria-label": "Gaps" }, h("div", { class: "card-head" }, h("div", {}, h("h2", { class: "t-section-title" }, "Biggest gaps"), h("div", { class: "caption muted" }, "Uncovered items, by priority (spec) and severity (risk)"))),
    c.gaps.length ? h("ol", { class: "gaps" }, ...c.gaps.slice(0, 12).map((g) => h("li", {}, h("div", { class: "item-id" }, h("span", { class: "eyebrow" }, g.map), h("span", { class: "mono" }, g.id), g.priority ? h("span", { class: `pill ${g.priority === "P0" ? "bad" : g.priority === "P1" ? "warn" : ""}` }, g.priority) : g.map === "risk" ? h("span", { class: `pill ${g.area === "high" ? "bad" : "warn"}` }, g.area) : null), g.title ? h("span", { class: "desc" }, g.title) : null, g.map === "risk" && g.depth === "planned" ? h("span", { class: "caption muted" }, "Has a check, but none that counts yet (its judge is not trusted).") : null)))
      : h("p", { class: "muted", style: "margin:0" }, "No gaps in the measured maps."),
    h("p", { class: "caption muted", style: "margin:0" }, "To close one, add a task whose source is spec:<id> or whose covers: lists it."));
  const scope = h("details", { class: "card scope", open: !localStorage.getItem("litmustest.coverage.scope-seen") || undefined, ontoggle: (e) => { if (!e.target.open) try { localStorage.setItem("litmustest.coverage.scope-seen", "1"); } catch {} } },
    h("summary", {}, h("strong", {}, "What coverage measures, and what it does not")),
    h("div", { class: "scope-cols" }, h("div", {}, h("span", { class: "eyebrow" }, "Measured"), h("ul", {}, ...c.scope.measures.map((x) => h("li", {}, x)))), h("div", {}, h("span", { class: "eyebrow" }, "Not measured"), h("ul", {}, ...c.scope.not_measured.map((x) => h("li", {}, x))))));
  const gaps = mapKey ? null : await gapsSection(); if (stale(seq)) return;
  const unset = maps.filter((m) => m.configured === false && (m.key === "spec" || m.key === "code"));
  page.replaceChildren(h("div", { class: "column" },
    coverTabs("gaps", unset.length ? h("a", { class: "btn", href: "#/cover/setup" }, "Set up coverage") : null),
    mapKey ? h("header", { class: "page-header" }, h("div", { class: "titles" }, h("h1", { class: "teach-title" }, `Coverage: ${maps.find((m) => m.key === key)?.label ?? key}`), h("p", { class: "subtitle" }, "How much of the application an eval would catch if it broke", c.run_id ? [" · against ", h("span", { class: "mono" }, c.run_id)] : " · no runs yet, so nothing is checked or guarded"))) : gaps,
    scope,
    h("div", { class: "cov-tiles" }, ...maps.map(tile)),
    plain("coverage", "coverage", { map: key }),
    ...(c.warnings.length ? [h("div", { class: "card warn-card" }, ...c.warnings.map((w) => h("p", { class: "caption", style: "margin:0" }, w)))] : []),
    h("div", { class: "two-col" }, h("div", { class: "main", style: "display:flex;flex-direction:column;gap:var(--space-4)" }, chartCard, itemTable), gapList)));
}

// ---------------- the biggest gaps (design/mockups/v2/CoverP): high-severity failure modes with no check you can trust
async function gapsSection() {
  const { failure_modes: modes } = await api("/api/modes");
  const enc = encodeURIComponent;
  const order = ["high", "med", "low"];
  const gaps = modes.filter((m) => m.severity === "high" && m.grader?.status !== "trusted").sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const why = (m) => m.grader?.kind === "judge" ? (m.grader.status === "stale" ? "Has a judge, but it changed after its test, so nothing it says counts." : "Has a judge that is not trusted yet.") : `${m.fail_labels ?? 0} failures in your labels. No check.`;
  const act = (m) => m.grader?.kind === "judge" ? h("a", { class: "btn", href: `#/teach/judges/${enc(m.name)}` }, m.grader.status === "stale" ? "Re-check judge" : "Open judge") : h("a", { class: "btn", href: `#/teach/judges/new?mode=${enc(m.name)}` }, "New judge");
  return h("section", { class: "gaps", "aria-label": "Biggest gaps" },
    h("p", { class: "eyebrow-status" }, gaps.length ? statusWord("warn", `${gaps.length} ${gaps.length === 1 ? "gap" : "gaps"}`) : statusWord("good", "No high-severity gaps")),
    h("h1", { class: "teach-title" }, gaps.length ? `${gaps.length} high-severity ${gaps.length === 1 ? "failure mode has" : "failure modes have"} no check you can trust` : "Every high-severity failure mode has a check you can trust"),
    h("p", { class: "subtitle" }, "“Covered” means a check would run, not that it catches every bug. ", term("coverage", "Coverage"), " below shows how much of the product the tasks reach."),
    gaps.length ? h("ol", { class: "gap-list" }, ...gaps.map((m, i) => h("li", { class: "gap-row" },
      h("span", { class: "gap-n", "aria-hidden": "true" }, String(i + 1)),
      h("div", { class: "gap-text" }, h("span", { class: "gap-head" }, h("a", { class: "mono", href: `#/teach/modes/${enc(m.name)}` }, m.name), statusWord("bad", "High")), h("span", {}, m.definition), h("span", { class: "caption muted" }, why(m))),
      act(m)))) : null);
}

// ---------------- set up coverage (design/mockups/v2/CoverageSetupP): the spec and code maps, written to litmustest.yaml
// through a validated write. Story connectors (Linear, Jira, GitHub Issues) are planned, not built.
export async function renderCoverageSetup() {
  const seq = state.seq; const page = $("#page");
  const f = await api(`/api/file?path=${encodeURIComponent("litmustest.yaml")}`); if (stale(seq)) return;
  const cfg = f.data ?? {}; const cov = cfg.coverage ?? {};
  const status = h("p", { class: "status", "aria-live": "polite" });
  const field = (id, label, value, hint, placeholder) => h("label", { class: "field" }, h("span", {}, label), h("input", { class: "text mono", id, value: value ?? "", placeholder }), hint ? h("span", { class: "caption muted" }, hint) : null);
  const planned = (name, what) => h("div", { class: "setup-row" }, h("div", {}, h("span", { class: "setup-name" }, name), h("span", { class: "caption muted" }, what)), h("span", { class: "planned-tag" }, "Planned"));
  async function save() {
    const files = $("#spec-files").value.split(",").map((x) => x.trim()).filter(Boolean); const pattern = $("#spec-pattern").value.trim(); const report = $("#code-report").value.trim();
    const next = { ...cov };
    if (files.length) next.spec = { ...(cov.spec ?? {}), files, id_pattern: pattern || "[A-Z]+-\\d+" }; else delete next.spec;
    if (report) next.code = { ...(cov.code ?? {}), report }; else delete next.code;
    status.className = "status"; status.textContent = "Saving…";
    try { await api("/api/file", { method: "PUT", body: JSON.stringify({ path: "litmustest.yaml", data: { ...cfg, coverage: next }, base_hash: f.hash }) }); await refreshHealth(); status.className = "status good"; status.textContent = "Saved to evals/litmustest.yaml. It is in Pending changes; the maps appear on Cover."; }
    catch (e) { status.className = "status bad"; status.textContent = `Not saved · ${e.body?.problems?.[0]?.message ?? e.message}`; }
  }
  page.replaceChildren(h("div", { class: "column setup" },
    coverTabs("gaps"),
    h("header", { class: "page-header" }, h("div", { class: "titles" }, h("h1", { class: "teach-title" }, "Measure two more kinds of coverage"), h("p", { class: "subtitle" }, "Both are optional. Each adds a map to Cover and a list of gaps you can turn into tasks."))),
    h("section", { class: "setup-section", "aria-label": "Your spec" },
      h("div", { class: "section-head" }, h("h2", {}, "Your spec"), h("span", { class: "caption muted" }, "Which acceptance criteria have a task")),
      field("spec-files", "Spec files", (cov.spec?.files ?? []).join(", "), "Paths or globs from the repository root, comma separated. Every match of the pattern in them is one criterion.", "docs/spec.md"),
      field("spec-pattern", "Criterion id pattern", cov.spec?.id_pattern, "A regular expression; a task covers a criterion with covers: or source: spec:<id>.", "[A-Z]+-\\d+"),
      planned("Linear", "Read stories and their acceptance criteria"), planned("Jira", "Read issues of type Story"), planned("GitHub Issues", "Read issues with a label you choose")),
    h("section", { class: "setup-section", "aria-label": "Your code" },
      h("div", { class: "section-head" }, h("h2", {}, "Your code"), h("span", { class: "caption muted" }, "Which code paths the tasks reach")),
      field("code-report", "Coverage report", cov.code?.report, "An lcov or Istanbul JSON file your agent's process writes during litmustest run. litmustest never runs your coverage tool for you.", "coverage/lcov.info")),
    h("div", { class: "home-actions" }, h("button", { type: "button", class: "btn primary", onclick: save }, "Save to Pending changes"), h("a", { class: "btn quiet", href: "#/cover" }, "Back to Cover")),
    status));
}
