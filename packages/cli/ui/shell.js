// litmustest dashboard: shell.js. The app shell of the redesign (docs/BRAND.md, Layout): a sidebar with the four places
// and the Library, one sheet with a top bar, and on phones a bottom bar with the four places and a Menu for the rest.
import { $, api, h } from "./lib/dom.js";
import { state } from "./lib/state.js";
import { NAV, crumbs, currentNav } from "./routes.js";
import { explainPageLink } from "./explainer.js";

export { NAV };

/** 16px stroke icons, drawn in currentColor so the item's colour carries through. */
const ICONS = {
  home: ["M2.5 7L8 2.5 13.5 7v6.5h-4v-4h-3v4h-4z"],
  ship: ["M3 13L13 3M6 3h7v7"],
  teach: ["M2.5 4.5h11M2.5 8h7M2.5 11.5h5", "M10.5 11l1.5 1.5 3-3"],
  cover: ["M8 2l5.5 2v4c0 3-2.4 5.2-5.5 6-3.1-.8-5.5-3-5.5-6V4z"],
  runs: ["M3 2.5h7l3 3v8H3z"],
  settings: ["M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4"],
  pending: ["M4.5 5.1v5.8M11.5 7.6c0 2-2 2.4-5.5 3.4"],
};
export function icon(name) {
  const svg = h("svg", { class: "icon", width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true" },
    ...ICONS[name].map((d) => h("path", { d, fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round" })));
  if (name === "settings") svg.append(h("circle", { cx: 8, cy: 8, r: 2.2, fill: "none", stroke: "currentColor", "stroke-width": "1.4" }));
  if (name === "pending") for (const [cx, cy] of [[4.5, 3.5], [4.5, 12.5], [11.5, 6]]) svg.append(h("circle", { cx, cy, r: 1.6, fill: "none", stroke: "currentColor", "stroke-width": "1.4" }));
  return svg;
}

export function setNavOpen(open) { $("#app").classList.toggle("nav-open", open); $("#nav-toggle").setAttribute("aria-expanded", open ? "true" : "false"); }
$("#nav-toggle").addEventListener("click", () => setNavOpen($("#nav-toggle").getAttribute("aria-expanded") !== "true"));
$("#scrim").addEventListener("click", () => setNavOpen(false));
addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#app").classList.contains("nav-open")) setNavOpen(false); });

/** What sits beside a nav item: plain text the item's own label explains. Ship, Home and Cover get theirs in R2–R4. */
function status(n) {
  if (n.icon === "teach" && state.batches.length) { const b = state.batches[0]; const left = b.items - b.labelled; if (left > 0) return h("span", { class: "nav-status", title: `${left} to label` }, `${left} to label`); }
  return null;
}

export function renderNav() {
  const cur = currentNav(state.path ?? []);
  const item = (n) => h("a", { class: "nav-item", href: n.href, "aria-current": n === cur ? "page" : undefined }, icon(n.icon), h("span", { class: "nav-label" }, n.label), status(n));
  $("#nav-items").replaceChildren(
    ...NAV.filter((n) => n.place).map(item),
    h("span", { class: "nav-section" }, "Library"),
    ...NAV.filter((n) => n.library).map(item),
  );
  $("#bottombar").replaceChildren(...NAV.filter((n) => n.place).map((n) => h("a", { class: "bottom-item", href: n.href, "aria-current": n === cur ? "page" : undefined }, icon(n.icon), h("span", {}, n.label))));
  const parts = crumbs(state.path ?? []);
  $("#nav-current").replaceChildren(...parts.flatMap(([text, href, kind], i) => [
    i ? h("span", { class: "sep", "aria-hidden": "true" }, "/") : null,
    href ? h("a", { href, class: kind === "mono" ? "mono" : undefined }, text) : h("span", { class: kind === "mono" ? "mono current" : "current", "aria-current": i === parts.length - 1 ? "page" : undefined }, text),
  ].filter(Boolean)));
  $("#topbar-explain").replaceChildren(explainPageLink());
  setNavOpen(false);
  const n = state.health?.pending ?? 0;
  const badge = $("#nav-pending"); badge.hidden = n === 0; badge.textContent = String(n); badge.setAttribute("aria-label", `${n} pending change${n === 1 ? "" : "s"}`);
  $("#tray").hidden = n === 0 && state.path?.[0] !== "pending";
  $("#tray").setAttribute("aria-current", state.path?.[0] === "pending" ? "page" : "false");
  $("#tray-count").textContent = `${n} pending change${n === 1 ? "" : "s"}`; $("#tray-branch").textContent = state.health?.branch ?? "";
  $("#project-name").textContent = state.health?.project ? state.health.project.replace(/_/g, "-") : "litmustest";
  const who = state.health?.annotator ?? "";
  $("#user").hidden = !who; $("#user-name").textContent = who;
  $("#user-initials").textContent = who.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

export async function refreshHealth() { state.health = await api("/api/health"); state.batches = (await api("/api/batches")).batches; state.modes = (await api("/api/failure_modes")).failure_modes; renderNav(); }
