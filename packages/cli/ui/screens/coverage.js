// litmustest dashboard: screens/coverage.js
import { plain } from "../explainer.js";
import { $, api, h } from "../lib/dom.js";
import { stale, state } from "../lib/state.js";

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
  page.replaceChildren(h("div", { class: "column" },
    h("header", { class: "page-header" }, h("div", { class: "titles" }, h("h1", { class: "t-page-title" }, "Coverage"), h("p", { class: "subtitle" }, "How much of the application an eval would catch if it broke", c.run_id ? [" · against ", h("span", { class: "mono" }, c.run_id)] : " · no runs yet, so nothing is checked or guarded"))),
    scope,
    h("div", { class: "cov-tiles" }, ...maps.map(tile)),
    plain("coverage", "coverage", { map: key }),
    ...(c.warnings.length ? [h("div", { class: "card warn-card" }, ...c.warnings.map((w) => h("p", { class: "caption", style: "margin:0" }, w)))] : []),
    h("div", { class: "two-col" }, h("div", { class: "main", style: "display:flex;flex-direction:column;gap:var(--space-4)" }, chartCard, itemTable), gapList)));
}
