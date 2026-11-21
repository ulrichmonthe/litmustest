// litmustest dashboard: routes.js. The redesign's places (docs/stories/redesign.md) and how they map onto the screens.
// URLs are by place: #/home, #/ship, #/teach/<step>, #/cover[/tasks], #/library/<runs|settings>, #/pending.
// The screens still read state.route in their original shape ("overview", "compare", "review", ...), so the router
// keeps that shape as the screen key and the place path beside it. Old links redirect to their place.

/** [place path prefix, screen key]. Order matters: the first prefix that matches wins, so longer ones come first. */
export const PLACES = [
  [["home"], "overview"],
  [["ship"], "compare"],
  [["teach", "label"], "review"],
  [["teach", "group"], "discover"],
  [["teach", "modes"], "modes"],
  [["teach", "judges"], "judges"],
  [["teach"], "review"],
  [["cover", "tasks"], "tasks"],
  [["cover"], "coverage"],
  [["library", "runs"], "transcripts"],
  [["library", "settings"], "settings"],
  [["library"], "transcripts"],
  [["pending"], "pending"],
];

/** Screen keys that were once URLs of their own; a link to one redirects to its place. */
export const OLD = new Set(["overview", "compare", "review", "discover", "modes", "judges", "coverage", "tasks", "transcripts", "settings"]);

const starts = (parts, prefix) => prefix.every((p, i) => parts[i] === p);

/** Place path → the screen route the screens understand, or null when nothing matches. */
export function toScreen(parts) {
  for (const [prefix, key] of PLACES) if (starts(parts, prefix)) return [key, ...parts.slice(prefix.length)];
  return null;
}

/** An old screen route → its place path. */
export function toPlace(parts) {
  const hit = PLACES.find(([, key]) => key === parts[0]);
  return hit ? [...hit[0], ...parts.slice(1)] : parts;
}

/** The hash for a place path. */
export const hashOf = (parts, qs = "") => "#/" + parts.map(encodeURIComponent).join("/") + (qs ? `?${qs}` : "");

/** The four places and the Library, in sidebar order. `match` is the place path prefix that marks the item current. */
export const NAV = [
  { label: "Home", href: "#/home", match: ["home"], icon: "home", place: true },
  { label: "Ship", href: "#/ship", match: ["ship"], icon: "ship", place: true },
  { label: "Teach", href: "#/teach/label", match: ["teach"], icon: "teach", place: true },
  { label: "Cover", href: "#/cover", match: ["cover"], icon: "cover", place: true },
  { label: "Runs and trials", href: "#/library/runs", match: ["library", "runs"], icon: "runs", library: true },
  { label: "Settings", href: "#/library/settings", match: ["library", "settings"], icon: "settings", library: true },
];

/** The current nav item for a place path (the longest match). */
export function currentNav(parts) {
  let best = null;
  for (const n of NAV) if (starts(parts, n.match) && (!best || n.match.length > best.match.length)) best = n;
  if (!best && parts[0] === "library") best = NAV.find((n) => n.icon === "runs");
  return best;
}

const STEP = { label: "Label", group: "Group notes", modes: "Failure modes", judges: "Trust judges" };
/** Breadcrumb for the top bar: [text, href|null] pairs. Identifiers (judge, task, run) are marked mono. */
export function crumbs(parts) {
  const [a, b, c, d, e] = parts;
  switch (a) {
    case "home": return [["Home", null]];
    case "ship": return b === "decide" ? [["Ship", "#/ship"], ["Decide", null]] : [["Ship", null]];
    case "pending": return [["Pending changes", null]];
    case "teach": {
      const step = STEP[b ?? "label"] ?? "Label";
      const out = [["Teach", "#/teach/label"], [step, c ? hashOf(["teach", b]) : null]];
      if (c && (b === "judges" || b === "modes")) out.push(c === "new" && b === "judges" ? ["New judge", null] : [c, null, "mono"]);
      return out;
    }
    case "cover": {
      if (b !== "tasks") return b ? [["Cover", "#/cover"], [b === "setup" ? "Set up coverage" : b, null]] : [["Cover", null]];
      const out = [["Cover", "#/cover"], ["Tasks and suites", c ? "#/cover/tasks" : null]];
      if (c) out.push([c, d ? hashOf(["cover", "tasks", c]) : null]);
      if (d) out.push([d, null, "mono"]);
      return out;
    }
    case "library": {
      if (b === "settings") return [["Library", null], ["Settings", null]];
      const out = [["Library", null], ["Runs and trials", c ? "#/library/runs" : null]];
      if (c) out.push([c, d ? hashOf(["library", "runs", c]) : null, "mono"]);
      if (d) out.push([d, null, "mono"]);
      if (e) out.push([`Trial ${e}`, null]);
      return out;
    }
    default: return [];
  }
}
