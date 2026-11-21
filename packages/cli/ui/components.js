// litmustest dashboard: components.js
import { $, h } from "./lib/dom.js";

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
