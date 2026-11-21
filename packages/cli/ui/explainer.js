// litmustest dashboard: explainer.js
import { step } from "./components.js";
import { $, api, h, short } from "./lib/dom.js";
import { stale, state } from "./lib/state.js";
import { render } from "./router.js";
import { review } from "./screens/review.js";

// ---------------- explainer (docs/EXPLAINER.md): what a term means, what it means here, what to do next.
// Words come from the glossary via the API; every number in a "here" sentence was computed by the server from the files.
export const gloss = { terms: new Map(), names: new Map(), pages: {}, learnMoreUrl: null, seen: new Set(), peek: null, peekFor: null, peekTimer: 0 };
// Plain language is a per-person preference: ~/.config/litmustest/prefs.json through /api/prefs, falling back to this
// browser's storage where the server keeps none (hosted mode). The repo only sets the default for newcomers.
export const PLAIN_KEY = "litmustest.plain";
export const THEME_KEY = "litmustest.theme";
export const prefs = { plain: true, promptSeen: true, local: false, theme: "system" };
// Theme: "system" follows the OS (tokens.css has the media query); light and dark set data-theme on the root.
export function applyTheme(theme) { prefs.theme = ["light", "dark"].includes(theme) ? theme : "system"; if (prefs.theme === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = prefs.theme; }
try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* storage blocked: follow the OS */ }
export async function setTheme(theme) { applyTheme(theme); try { localStorage.setItem(THEME_KEY, prefs.theme); } catch { /* lasts this visit */ } await savePrefs({ theme: prefs.theme }); }
export async function loadPrefs() {
  try { const p = await api("/api/prefs"); Object.assign(prefs, { plain: p.plain_language_effective, promptSeen: Boolean(p.plain_prompt_seen), local: false }); if (p.theme) applyTheme(p.theme); }
  catch { let v = null; try { v = localStorage.getItem(PLAIN_KEY); } catch { /* storage blocked */ } Object.assign(prefs, { plain: v !== "off", promptSeen: v !== null, local: true }); }
}
export async function savePrefs(patch) {
  if (!prefs.local) { try { await api("/api/prefs", { method: "PUT", body: JSON.stringify(patch) }); return; } catch { prefs.local = true; } }
  try { if ("plain_language" in patch) localStorage.setItem(PLAIN_KEY, patch.plain_language ? "on" : "off"); } catch { /* the choice lasts this visit */ }
}
export const plainOn = () => prefs.plain;
export async function setPlain(on) { prefs.plain = on; prefs.promptSeen = true; await savePrefs({ plain_language: on, plain_prompt_seen: true }); render(); }
/** A rate is never shown without its margin (the 95% interval beside it), and it links to the tasks behind it. */
export const rate = (value, ci, href) => {
  if (value === null || value === undefined) return "—";
  const kids = [h("span", { class: "rate-v" }, `${value}%`), ci && ci.low !== undefined && ci.low !== null ? h("span", { class: "rate-ci", title: "95% interval: the range the true rate plausibly sits in" }, ` ${ci.low}–${ci.high}`) : null];
  return href ? h("a", { class: "rate", href }, ...kids) : h("span", { class: "rate" }, ...kids);
};
/** A count links to the list it counts. */
export const count = (n, href) => h("a", { class: "count-link", href }, String(n));
/** The line above a list that a link filtered, with the way back. */
export const filterNote = (text, clearHref) => h("p", { class: "caption muted filter-note" }, text, " ", h("a", { href: clearHref }, "Show all"));
export async function loadGlossary() {
  try { const g = await api("/api/glossary"); gloss.terms = new Map(g.terms.map((t) => [t.id, t])); gloss.pages = g.pages ?? {}; gloss.learnMoreUrl = g.learn_more_url; gloss.names = new Map(); for (const t of g.terms) for (const k of [t.id, t.term, ...(t.aliases ?? [])]) gloss.names.set(k.toLowerCase(), t.id); renderShorts(); }
  catch { /* the dashboard still works without explanations */ }
}
export const termOf = (q) => gloss.terms.get(gloss.names.get(String(q).toLowerCase()) ?? q);
export const unlinkTerms = (s) => String(s).replace(/\[\[([a-z0-9_]+)\]\]/g, (_, id) => gloss.terms.get(id)?.term.toLowerCase() ?? id);
/** A term in running text: dotted underline on its first use per screen; later uses are plain words. */
export function term(id, text) {
  const t = termOf(id); const label = text ?? t?.term ?? id;
  if (!t || gloss.seen.has(t.id)) return label;
  gloss.seen.add(t.id);
  return trigger(h("span", { "data-kind": "word" }, label), { id: t.id });
}
/** A number, delta or status pill that explains itself: always a trigger, and its explanation reads this value's facts. */
export function num(id, source, ctx, content) {
  const t = termOf(id); if (!t) return content;
  return trigger(h("span", { "data-kind": "value" }, content), { id: t.id, source, ctx });
}
export function trigger(el, spec) {
  el.classList.add("term"); el.setAttribute("tabindex", "0"); el.setAttribute("role", "button"); el.dataset.term = spec.id;
  el.setAttribute("aria-haspopup", "dialog"); el.setAttribute("aria-expanded", "false");
  el.setAttribute("aria-describedby", `gloss-short-${spec.id}`);
  el._spec = spec; wireTrigger(el, spec); return el;
}
/** Status words in pills that are not the glossary term's own name. */
export const PILL_TERM = { pass: "label", fail: "label", skip: "label", broke: "flip", fixed: "flip", significant: "confidence_interval", "within noise": "confidence_interval", high: "severity", med: "severity", low: "severity", "high severity": "severity", passing: "task_status", failing: "task_status", mixed: "task_status", "no runs": "task_status", "ready to graduate": "graduation", "judge · stale": "stale", "judge · trusted": "trusted", untested: "calibration", dev: "calibration", "has check": "check", "no grader": "grader", none: "coverage_depth", checked: "coverage_depth" };
export const pillTermId = (text) => { const w = String(text).replace(/\?/g, "").split(" · ")[0].replace(/(^|\s)\d+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim().toLowerCase(); return PILL_TERM[w] ?? (termOf(w) ? termOf(w).id : termOf(w.replace(/s$/, ""))?.id); };
/** Every status pill on the page is a trigger: pills placed with num() already are; the rest explain their word. */
export function wirePills() { for (const p of document.querySelectorAll("#page .pill")) { if (p.closest(".term, button, a, .popover")) continue; const id = pillTermId(p.textContent); if (id) { const w = h("span", { "data-kind": "pill" }); p.replaceWith(w); w.append(p); trigger(w, { id }); } } }
/** Plain language: the "here" sentence under a card, filled after the page renders. Nothing when the viewer turned it off. */
export function plain(id, source, ctx = {}) { return plainOn() && termOf(id) ? h("p", { class: "plain-line", "data-plain": JSON.stringify({ id: termOf(id).id, source, ctx }) }) : null; }
export async function fillPlain(seq) {
  const els = [...document.querySelectorAll("#page .plain-line[data-plain]")]; if (!els.length) return;
  let r; try { r = await api("/api/glossary/here", { method: "POST", body: JSON.stringify({ items: els.map((e) => JSON.parse(e.dataset.plain)) }) }); } catch { return; }
  if (stale(seq)) return;
  r.items.forEach((it, i) => { const el = els[i]; if (!it.here) { el.remove(); return; } el.replaceChildren(...[it.here, ...(it.next ? [" ", it.next.link ? h("a", { href: it.next.link }, it.next.say) : h("span", { class: "next" }, it.next.say)] : [])]); });
}
/** Hidden one-line definitions the triggers point at with aria-describedby; the peek shows the same text. */
export function renderShorts() {
  $("#gloss-shorts")?.remove();
  document.body.append(h("div", { id: "gloss-shorts", class: "sr-only" }, ...[...gloss.terms.values()].map((t) => h("span", { id: `gloss-short-${t.id}` }, unlinkTerms(t.short)))));
}
// Peek (tier 1): `short` only, after 400ms of hover or on keyboard focus; never on touch, where a tap opens the explanation.
export const PEEK_DELAY = 400;
export const hoverCapable = () => matchMedia("(hover: hover)").matches;
export let lastPointer = "mouse";
addEventListener("pointerdown", (e) => { lastPointer = e.pointerType || "mouse"; }, true);
export function showPeek(el, id) {
  hidePeek(); if (panel.open && panel.opener === el) return;
  const t = gloss.terms.get(id); if (!t) return;
  const peek = h("div", { class: "peek", id: "gloss-peek", role: "tooltip" }, h("span", {}, unlinkTerms(t.short)), " ", h("span", { class: "hint" }, "Click for more"));
  document.body.append(peek); gloss.peek = peek; gloss.peekFor = el;
  const r = el.getBoundingClientRect(); const w = peek.offsetWidth;
  peek.style.top = `${r.bottom + 2}px`; peek.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;
}
export function hidePeek() { clearTimeout(gloss.peekTimer); gloss.peek?.remove(); gloss.peek = null; gloss.peekFor = null; }
export function wireTrigger(el, spec) {
  el.addEventListener("pointerenter", (e) => { if (e.pointerType === "touch" || !hoverCapable()) return; clearTimeout(gloss.peekTimer); gloss.peekTimer = setTimeout(() => showPeek(el, spec.id), PEEK_DELAY); });
  el.addEventListener("pointerleave", () => { if (gloss.peekFor === el || gloss.peekTimer) hidePeek(); });
  el.addEventListener("focus", () => { if (lastPointer !== "touch" && el.matches(":focus-visible")) showPeek(el, spec.id); });
  el.addEventListener("blur", () => { if (gloss.peekFor === el) hidePeek(); });
  // Tier 2: click, tap or Enter opens the panel, or updates it in place when it is already open.
  const open = (e) => { e.preventDefault(); e.stopPropagation(); hidePeek(); openPanel(spec, el); };
  el.addEventListener("click", open);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(e); });
}
// ---------------- explain panel (tier 2): docked on the right, pushing the page aside; a bottom sheet below 900px.
// Opened by click, tap or Enter on a term, by ? or "Explain this page" (page mode). It stays open across screens.
export const panel = { open: false, mode: "term", spec: null, opener: null, seq: 0 };
/** Commands a page offers. Its own buttons call these handlers, and so do the panel's next-step buttons. Cleared per render. */
export const commands = new Map();
export function command(id, def) { commands.set(id, def); return def; }
// A transcript_ref is the store's address (local:run/task/n, s3://bucket/prefix/run/task/n, langfuse:run/task/n ...); its last three segments are always run, task and trial.
export const refHref = (ref) => { const p = String(ref ?? "").replace(/^[a-z0-9]+:(\/\/)?/, "").split("/").filter(Boolean); return p.length >= 3 ? `#/transcripts/${p.slice(-3).map(encodeURIComponent).join("/")}` : "#/transcripts"; };
export const screenKey = () => { const [r0, r1, , r3] = state.route; return r0 === "judges" && r1 ? "judge" : r0 === "tasks" && state.route[2] ? "task" : r0 === "transcripts" && r3 ? "trial" : r0 ?? "overview"; };
export function setOpener(el) {
  panel.opener?.setAttribute("aria-expanded", "false");
  panel.opener = el ?? null;
  if (el) { el.setAttribute("aria-expanded", "true"); el.setAttribute("aria-controls", "explain-panel"); }
}
export function openPanel(spec, opener) {
  Object.assign(panel, { open: true, mode: "term", spec }); setOpener(opener);
  document.body.classList.add("panel-open"); renderPanel();
}
export function openPageMode(opener) {
  Object.assign(panel, { open: true, mode: "page", spec: null }); setOpener(opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  document.body.classList.add("panel-open"); renderPanel();
}
export function closePanel() {
  panel.prompt = false; const opener = panel.opener; Object.assign(panel, { open: false, spec: null }); setOpener(null);
  document.body.classList.remove("panel-open"); const el = $("#explain-panel"); el.hidden = true; el.replaceChildren();
  if (opener?.isConnected) opener.focus();
}
export const sameCtx = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
/** After a screen renders: keep the panel on the same term if this screen shows it; otherwise it clears to page mode. */
export function syncPanel() {
  if (!panel.open) return;
  if (panel.mode === "term") {
    const match = [...document.querySelectorAll("#page .term")].find((t) => t._spec?.id === panel.spec.id && (t._spec.source ?? null) === (panel.spec.source ?? null) && sameCtx(t._spec.ctx, panel.spec.ctx)) ?? [...document.querySelectorAll("#page .term")].find((t) => t._spec?.id === panel.spec.id);
    if (!match) { panel.mode = "page"; panel.spec = null; setOpener(null); } else { panel.spec = match._spec; setOpener(match); }
  }
  renderPanel();
}
export const explainOne = async (spec) => (await api("/api/glossary/here", { method: "POST", body: JSON.stringify({ items: [{ id: spec.id, source: spec.source ?? undefined, ctx: spec.ctx ?? {} }] }) })).items[0];
export function nextStep(next) {
  if (!next) return null;
  const cmds = (next.action ?? []).map((id) => [id, commands.get(id)]).filter(([, c]) => c);
  if (cmds.length) return h("div", { class: "panel-actions" }, h("p", {}, next.say), h("div", { class: "row" }, ...cmds.map(([id, c], i) => { const ok = c.enabled ? c.enabled() : true; return h("button", { type: "button", class: `btn${i === 0 ? " primary" : ""}`, "data-action": id, disabled: !ok, title: !ok ? c.reason?.() ?? "" : "", onclick: async () => { await c.run(); } }, c.label()); })), ...cmds.filter(([, c]) => c.enabled && !c.enabled() && c.reason).map(([, c]) => h("p", { class: "caption muted" }, c.reason())));
  const here = next.link && next.link !== location.hash;
  return h("p", {}, here ? h("a", { href: next.link }, next.say) : next.say);
}
export async function renderPanel() {
  const el = $("#explain-panel"); if (!panel.open) return; el.hidden = false;
  const seq = ++panel.seq;
  const close = h("div", { class: "panel-tools" }, h("label", { class: "checkline panel-plain" }, h("input", { type: "checkbox", id: "plain-panel", checked: plainOn(), onchange: (e) => setPlain(e.target.checked) }), h("span", {}, "Plain language")), h("button", { type: "button", class: "btn panel-close", "aria-label": "Close explanation", onclick: closePanel }, "Close"));
  // The first panel a newcomer opens offers, once, to turn Plain language off.
  if (!prefs.promptSeen && prefs.plain) { prefs.promptSeen = true; panel.prompt = true; savePrefs({ plain_prompt_seen: true }); }
  const prompt = panel.prompt && prefs.plain ? h("div", { class: "panel-prompt" }, h("p", { class: "muted" }, "Plain language puts these sentences under every number. If you know the numbers already:"), h("button", { type: "button", class: "btn", id: "plain-off-once", onclick: () => { panel.prompt = false; setPlain(false); } }, "Turn off Plain language")) : null;
  if (panel.mode === "page") {
    const ids = gloss.pages[screenKey()] ?? [];
    const found = []; for (const id of ids) { const t = [...document.querySelectorAll("#page .term")].find((x) => x._spec?.id === id && x._spec.source) ?? [...document.querySelectorAll("#page .term")].find((x) => x._spec?.id === id); if (t && !found.some((f) => f.el === t)) found.push({ el: t, spec: t._spec }); if (found.length === 3) break; }
    el.replaceChildren(...[h("div", { class: "panel-head" }, h("h2", { class: "t-section-title" }, "This page"), close), prompt, found.length ? h("ol", { class: "panel-list" }, ...found.map((f) => h("li", {}, h("button", { type: "button", class: "linklike", onclick: () => { f.el.scrollIntoView({ block: "nearest" }); openPanel(f.spec, f.el); } }, gloss.terms.get(f.spec.id)?.term ?? f.spec.id), h("p", { class: "muted" }, unlinkTerms(gloss.terms.get(f.spec.id)?.short ?? ""))))) : h("p", { class: "muted" }, "Nothing on this screen to explain yet.")].filter(Boolean));
    const items = await Promise.all(found.map((f) => explainOne(f.spec).catch(() => null))); if (seq !== panel.seq) return;
    items.forEach((it, i) => { if (it?.here) el.querySelectorAll(".panel-list li p")[i].replaceChildren(it.here); });
    return;
  }
  const t = gloss.terms.get(panel.spec.id); if (!t) return closePanel();
  const body = h("div", { class: "panel-body" }, h("p", {}, unlinkTerms(t.short)));
  el.replaceChildren(...[h("div", { class: "panel-head" }, h("h2", { class: "t-section-title" }, t.term), close), prompt, body].filter(Boolean));
  let x = null; try { x = await explainOne(panel.spec); } catch { /* layer 1 stays */ } if (seq !== panel.seq) return;
  if (x?.here) body.append(h("h3", { class: "eyebrow" }, "What it means here"), h("p", {}, x.here));
  if (x?.next) body.append(h("h3", { class: "eyebrow" }, "Next step"), nextStep(x.next));
  if (x?.examples && (x.examples.pass || x.examples.fail)) body.append(h("h3", { class: "eyebrow" }, "From your labels"), ...[["Fail", x.examples.fail], ["Pass", x.examples.pass]].filter(([, e]) => e).map(([l, e]) => h("p", { class: "example" }, h("span", { class: `pill ${l === "Fail" ? "bad" : "good"}` }, l), " ", h("a", { class: "mono", href: `#/review/${encodeURIComponent(state.batches[0]?.name ?? "")}/${encodeURIComponent(e.trace_id)}` }, e.trace_id), e.note ? ` ${short(e.note, 90)}` : "")));
  if (t.why) body.append(h("h3", { class: "eyebrow" }, "Why it matters"), h("p", {}, t.why));
  const related = (x?.related ?? (t.related ?? []).map((id) => ({ id, term: gloss.terms.get(id)?.term ?? id }))).filter((r) => gloss.terms.has(r.id));
  if (related.length) body.append(h("h3", { class: "eyebrow" }, "Related"), h("div", { class: "chips" }, ...related.map((r) => h("button", { type: "button", class: "chip", onclick: () => openPanel({ id: r.id, source: panel.spec.source, ctx: panel.spec.ctx }, panel.opener) }, r.term))));
  if (t.learn_more) { const ch = t.learn_more.split("ch-")[1]; body.append(h("p", { class: "more" }, gloss.learnMoreUrl ? h("a", { href: `${gloss.learnMoreUrl}#ch-${ch}`, target: "_blank", rel: "noopener" }, `Learn more: Master Class, chapter ${ch}`) : `Learn more: Master Class, chapter ${ch}`)); }
}
// Escape closes the panel and returns focus; ? (outside a text field) opens page mode or closes the panel.
document.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLElement && (e.target.matches("input, textarea, select, [contenteditable]"));
  if (e.key === "Escape" && panel.open) { e.stopPropagation(); e.preventDefault(); closePanel(); return; }
  if (e.key === "?" && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); e.stopPropagation(); if (panel.open) closePanel(); else openPageMode(); }
}, true);
/** doctor's alert kinds as the term and source that explain them; the same mapping as alertTerm in glossary_cli.ts. */
export function alertTerm(kind, href) {
  const p = String(href ?? "").replace(/^#\//, "").split("/").map(decodeURIComponent);
  if (kind === "Judge stale" && p[0] === "judges") return { id: "stale", source: "judge", ctx: { judge: p[1] } };
  if (kind === "Flaky task" && p[0] === "tasks") return { id: "flaky", source: "task", ctx: { task: p[2] } };
  if (kind === "Broken task" && p[0] === "tasks") return { id: "likely_broken", source: "task", ctx: { task: p[2] } };
  if (kind === "Review queue") return { id: "label", source: "queue", ctx: {} };
  if (/graduat/i.test(kind)) return { id: "graduation" };
  return null;
}
/** "Explain this page" in the verdict strip: the panel in page mode (the same as pressing ?). */
export function explainPageLink() { const b = h("button", { type: "button", class: "linklike explain-page", "aria-haspopup": "dialog", "aria-controls": "explain-panel" }, "Explain this page"); b.addEventListener("click", () => openPageMode(b)); return b; }
