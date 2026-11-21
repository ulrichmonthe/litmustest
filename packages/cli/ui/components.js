// litmustest dashboard: components.js
import { $, h } from "./lib/dom.js";
import { state } from "./lib/state.js";

export function step(time, dotClass, body) { return h("li", { class: "step" }, h("span", { class: "time" }, time), h("div", { class: "rail", "aria-hidden": "true" }, h("span", { class: `dot ${dotClass}` }), h("span", { class: "line" })), h("div", { class: "step-body" }, ...body)); }
export function header(title, sub) { return h("header", { class: "page-header" }, h("div", { class: "titles" }, h("h1", { class: "t-page-title" }, title), sub && h("p", { class: "subtitle" }, sub))); }

export function renderSoon(title) { $("#page").replaceChildren(h("div", { class: "column" }, header(title), h("p", { class: "empty" }, "Nothing lives at this address. ", h("a", { href: "#/home" }, "Go to Home"), "."))); }

// ---------------- the redesign's components (docs/BRAND.md, Components)
/** A status: a small dot in a dot- token and its word. level is good, warn, bad or none (a hollow ring). */
export function statusDot(level) { return h("span", { class: `sdot ${level}`, "aria-hidden": "true" }); }
export function statusWord(level, word, attrs = {}) { return h("span", { class: `status-word ${level}`, ...attrs }, statusDot(level), word); }
/** The margin bar: the likely range as a band, the measured rate as a tick, the gate as a dashed line. Always labelled in words. */
export function marginBar({ rate, ci, min, label }) {
  const pc = (v) => `${Math.max(0, Math.min(100, Number(v)))}%`;
  return h("div", { class: "mbar", role: "img", "aria-label": label },
    ci ? h("span", { class: "mbar-band", style: `left:${pc(ci.low)};width:${pc(ci.high - ci.low)}` }) : null,
    rate !== null && rate !== undefined ? h("span", { class: "mbar-tick", style: `left:${pc(rate)}` }) : null,
    min !== null && min !== undefined ? h("span", { class: "mbar-gate", style: `left:${pc(min)}` }) : null);
}
/** One dot per trial, in order: passed, failed, or a hollow ring for an infrastructure error, which is not counted. */
export function trialDots(dots, label) {
  return h("span", { class: "tdots", role: "img", "aria-label": label }, ...(dots ?? []).map((d) => h("span", { class: `tdot ${d}` })));
}
export const dotsLabel = (when, dots) => { const ok = (dots ?? []).filter((d) => d === "pass").length; const counted = (dots ?? []).filter((d) => d !== "infra").length; const infra = (dots ?? []).length - counted; return `${when}: ${ok} of ${counted} passed${infra ? `, ${infra} infrastructure error${infra > 1 ? "s" : ""}` : ""}`; };
export function kbd(text) { return h("kbd", {}, text); }
/** A 95% range rounded for reading: 77.9–92.3 reads as 78–92. */
export const roundCi = (ci) => (ci ? { low: Math.round(ci.low), high: Math.round(ci.high) } : null);
export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");
/** A paired change in points with its range, and whether it is real or within noise. */
export const deltaText = (d) => (d ? `${signed(d.pts)} pts (${signed(Math.round(d.ci.low))} to ${signed(Math.round(d.ci.high))})` : "");

/** The Teach rail (design/mockups/v2/TeachP): four steps, each a link with its count and a check mark when it is done. */
export function teachRail(current) {
  const t = state.teach;
  const steps = [
    ["label", "Label", t?.label.total ? `${t.label.done} of ${t.label.total}` : "No batch yet", Boolean(t?.label.total && t.label.done === t.label.total), "#/teach/label"],
    ["group", "Group notes", t ? `${t.group.notes} ${t.group.notes === 1 ? "note" : "notes"}` : "", Boolean(t && t.group.notes > 0 && t.group.loose === 0), "#/teach/group"],
    ["modes", "Failure modes", t ? `${t.modes.named} named` : "", Boolean(t && t.modes.named > 0), "#/teach/modes"],
    ["judges", "Trust judges", t?.judges.total ? `${t.judges.trusted} of ${t.judges.total} trusted` : "None yet", Boolean(t?.judges.total && t.judges.trusted === t.judges.total), "#/teach/judges"],
  ];
  return h("nav", { class: "teach-rail", "aria-label": "Teach steps" }, h("ol", {}, ...steps.map(([key, title, sub, done, href], i) =>
    h("li", {}, h("a", { href, "aria-current": key === current ? "step" : undefined, class: done ? "done" : undefined },
      h("span", { class: "rail-n", "aria-hidden": "true" }, done ? "✓" : String(i + 1)),
      h("span", { class: "rail-text" }, h("span", { class: "rail-title" }, title, done ? h("span", { class: "sr-only" }, " (done)") : null), h("span", { class: "rail-sub" }, sub)))))));
}
/** A Teach page heading: the step's question, a line under it, and the page's actions on the right. */
export function teachHead(title, sub, ...actions) {
  return h("header", { class: "teach-head" }, h("div", { class: "titles" }, h("h1", { class: "teach-title" }, title), sub ? h("p", { class: "subtitle" }, ...[sub].flat()) : null), actions.filter(Boolean).length ? h("div", { class: "teach-actions" }, ...actions) : null);
}
