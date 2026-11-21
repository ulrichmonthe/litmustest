// litmustest dashboard: screens/pending.js
import { header } from "../components.js";
import { command, num, term } from "../explainer.js";
import { $, ago, api, h } from "../lib/dom.js";
import { stale, state } from "../lib/state.js";
import { refreshHealth } from "../shell.js";

// ---------------- pending changes
export const pendingFlash = { text: "", ok: false };
export async function renderPending() {
  const seq = state.seq;
  const p = await api("/api/pending");
  if (stale(seq)) return;
  const page = $("#page");
  const file = (f) => h("div", { class: "pending-file" }, h("div", { class: "row" }, h("span", { class: "mono" }, f.path.replace(/^.*?evals\//, "")), h("span", { class: `pill ${f.status === "added" ? "good" : f.status === "deleted" ? "bad" : "blue"}` }, f.status), h("span", { class: "caption muted" }, f.affected_views.join(", ") || "", ` · ${ago(f.written_at)}`)), h("pre", { class: "code-block" }, ...f.diff.split("\n").flatMap((l, i) => { const marker = ["---", "+++", "@@"].find((m) => l.startsWith(m)); const cls = l.startsWith("+") && !l.startsWith("+++") ? "diff-add" : l.startsWith("-") && !l.startsWith("---") ? "diff-del" : l.startsWith("@@") ? "diff-hunk" : ""; return [i ? "\n" : "", h("span", { class: cls }, marker ? [term({ "---": "diff_old", "+++": "diff_new", "@@": "diff_hunk" }[marker], marker), l.slice(marker.length)] : l)]; })));
  const msg = h("input", { class: "text", placeholder: "Commit message (optional)", "aria-label": "Commit message", style: "flex:1 1 260px" });
  // What the last action did survives the re-render that follows it.
  const status = h("span", { class: `status${pendingFlash.ok ? " good" : ""}`, "aria-live": "polite" }, pendingFlash.text); pendingFlash.text = ""; pendingFlash.ok = false;
  const n = p.files.length; const target = p.commit_branch ?? p.branch;
  const commit = { label: () => `Commit ${n} file${n === 1 ? "" : "s"} to ${target}`, enabled: () => n > 0, reason: () => "Nothing to commit.", run: () => act("/api/pending/commit", { message: msg.value || undefined }, (r) => `Committed ${r.commit} on ${r.branch}`) };
  const openPr = { label: () => "Open PR", enabled: () => n === 0 && p.branch.startsWith("evals/"), reason: () => (n ? "Commit first; a pull request carries committed work." : `Open PR works from an evals branch; ${p.branch} is not one. Commit an edit to start one.`), run: () => act("/api/pending/pr", {}, (r) => `Opened ${r.url}`) };
  const discard = { label: () => "Discard", enabled: () => n > 0, reason: () => "Nothing to discard.", run: () => { if (confirm("Discard every pending change? This reverts the files on disk.")) act("/api/pending/discard", {}, (r) => `Discarded ${r.discarded.length} files`); } };
  if (!p.hosted) { command("pending.commit", commit); command("pending.openPr", openPr); command("pending.discard", discard); }
  const act = async (path, body, label) => { try { const r = await api(path, { method: "POST", body: JSON.stringify(body) }); Object.assign(pendingFlash, { text: label(r), ok: true }); await refreshHealth(); await renderPending(); } catch (e) { status.textContent = `${e.message}${e.body?.command ? ` · run: ${e.body.command}` : ""}`; status.className = "status bad"; } };
  if (p.hosted) return renderHostedPending(page, p, file, status, act);
  page.replaceChildren(h("div", { class: "column" }, header("Pending changes", h("span", {}, num("pending_changes", "pending", {}, `${n} changed file${n === 1 ? "" : "s"}`), " · on ", num("branch", "pending", {}, h("span", { class: "mono" }, p.branch)), ". Every save from the dashboard lands here as a diff; nothing reaches git until you commit.")),
    h("section", { class: "card", "aria-label": "Changes" }, ...(p.files.length ? p.files.map(file) : [h("p", { class: "muted", style: "margin:0" }, "Nothing pending.")])),
    h("div", { class: "save-row" }, msg, h("button", { type: "button", class: "btn primary", disabled: !commit.enabled(), onclick: commit.run }, commit.label()), h("button", { type: "button", class: "btn", disabled: !openPr.enabled(), title: openPr.enabled() ? "" : openPr.reason(), onclick: openPr.run }, openPr.label()), h("button", { type: "button", class: "btn", style: "color:var(--bad)", disabled: !discard.enabled(), onclick: discard.run }, discard.label()), status,
      // A disabled button says what unblocks it.
      h("span", { class: "caption muted" }, n === 0 ? num("pending_changes", "pending", {}, "Nothing to commit yet.") : !openPr.enabled() ? num("branch", "pending", {}, openPr.reason()) : null))));
}

// Hosted mode: every save is already a commit on the pull-request branch, so the tray shows the pull request,
// its commits and what the branch changes against its base. There is nothing to commit; Discard is a commit that restores the base.
export function renderHostedPending(page, p, file, status, act) {
  const n = p.files.length;
  const discard = { label: () => "Discard", enabled: () => n > 0, reason: () => "Nothing to discard.", run: () => { if (confirm(`Restore every changed file to ${p.base}? This is a new commit on ${p.branch}; the history keeps what it replaces.`)) act("/api/pending/discard", {}, (r) => `Discarded ${r.discarded.length} files`); } };
  command("pending.discard", discard);
  const pr = p.pr ? h("a", { href: p.pr.url, target: "_blank", rel: "noopener" }, `Pull request #${p.pr.number}`) : h("span", { class: "muted" }, "The pull request opens with the first save.");
  const commits = h("section", { class: "card", "aria-label": "Commits" }, h("div", { class: "card-head" }, pr, h("span", { class: "caption muted" }, `${p.commits.length} commit${p.commits.length === 1 ? "" : "s"} against `, h("span", { class: "mono" }, p.base))),
    ...(p.commits.length ? p.commits.map((c) => h("div", { class: "row", style: "gap:12px;padding:6px 0" }, h("span", { class: "mono" }, c.sha), h("span", { style: "flex:1 1 auto;min-width:0" }, c.message), h("span", { class: "caption muted" }, `${c.author} · ${ago(c.at)}`))) : [h("p", { class: "muted", style: "margin:0" }, "No saves on this branch yet.")]));
  page.replaceChildren(h("div", { class: "column" }, header("Pending changes", h("span", {}, num("pending_changes", "pending", {}, `${n} changed file${n === 1 ? "" : "s"}`), " · on ", num("branch", "pending", {}, h("span", { class: "mono" }, p.branch)), `. Every save is a commit on this branch, authored by whoever made it. Nothing reaches ${p.base} until a person merges the pull request.`)),
    commits,
    h("section", { class: "card", "aria-label": "Changes" }, ...(n ? p.files.map(file) : [h("p", { class: "muted", style: "margin:0" }, "Nothing changed against the base.")])),
    h("div", { class: "save-row" }, h("button", { type: "button", class: "btn", style: "color:var(--bad)", disabled: !discard.enabled(), onclick: discard.run }, discard.label()), status)));
}
