// litmustest dashboard: screens/discover.js
import { $, api, esc, h } from "../lib/dom.js";
import { stale, state } from "../lib/state.js";
import { review } from "./review.js";
import { refreshHealth } from "../shell.js";

// ---------------- discover: proposed failure modes from notes
export const disc = { result: null, batch: null, chosen: new Set(), busy: false, error: "" };
export async function renderDiscover(batchName) {
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
