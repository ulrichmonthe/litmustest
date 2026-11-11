import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { serialize } from "../packages/cli/src/server/serialize.ts";

const before = `name: band_gap
definition: >-
  A class on an age band the product claims to support cannot get a session. Fail when it cannot compose. Pass when it can and does.
severity: med
owner: founder # who decides
created: 2026-10-27
`;
const d = parse(before);

describe("serialize keeps diffs minimal", () => {
  it("returns the file unchanged when the data is unchanged, whatever the key order", () => {
    expect(serialize("failure_modes/x.yaml", { created: d.created, owner: d.owner, severity: d.severity, definition: d.definition, name: d.name }, before)).toBe(before);
  });
  it("changes one line for a severity edit and keeps order, style and comments", () => {
    const out = serialize("failure_modes/x.yaml", { ...d, severity: "high" }, before);
    expect(out).toBe(before.replace("severity: med", "severity: high"));
  });
  it("keeps the folded style when the definition changes, and drops removed keys", () => {
    const { owner: _o, ...rest } = d;
    const out = serialize("failure_modes/x.yaml", { ...rest, definition: d.definition + " Extra." }, before);
    expect(out).toContain("definition: >-\n");
    expect(out).not.toContain("owner");
    expect(parse(out)).toEqual({ ...rest, definition: d.definition + " Extra." });
    expect(out.split("\n")[0]).toBe("name: band_gap");
  });
  it("keeps JSON key order and writes new files plainly", () => {
    expect(serialize("refs/a.json", { b: 2, a: 1 }, '{\n  "a": 1,\n  "b": 1\n}\n')).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
    expect(serialize("failure_modes/n.yaml", { name: "n", severity: "low" })).toBe("name: n\nseverity: low\n");
  });
});
