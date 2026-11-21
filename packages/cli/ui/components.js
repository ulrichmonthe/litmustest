// litmustest dashboard: components.js
import { $, h } from "./lib/dom.js";

export function step(time, dotClass, body) { return h("li", { class: "step" }, h("span", { class: "time" }, time), h("div", { class: "rail", "aria-hidden": "true" }, h("span", { class: `dot ${dotClass}` }), h("span", { class: "line" })), h("div", { class: "step-body" }, ...body)); }
export function header(title, sub) { return h("header", { class: "page-header" }, h("div", { class: "titles" }, h("h1", { class: "t-page-title" }, title), sub && h("p", { class: "subtitle" }, sub))); }

export function renderSoon(title) { $("#page").replaceChildren(h("div", { class: "column" }, header(title), h("p", { class: "empty" }, "Nothing lives at this address. ", h("a", { href: "#/home" }, "Go to Home"), "."))); }
