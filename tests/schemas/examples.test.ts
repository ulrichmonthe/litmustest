import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { SchemaSet, loadSchemas } from "../../packages/cli/src/schemas.ts";

const examplesDir = join(import.meta.dirname, "examples");
const schemas = new SchemaSet();
const fileTypes = Object.keys(loadSchemas()).filter((n) => n !== "common");

function loadExample(file: string): unknown[] {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  if (file.endsWith(".json")) return [JSON.parse(text)];
  return [parseYaml(text)];
}

describe("every schema has a valid and an invalid example", () => {
  for (const name of fileTypes) {
    const dir = join(examplesDir, name);
    const files = readdirSync(dir);
    const valid = files.filter((f) => f.startsWith("valid"));
    const invalid = files.filter((f) => f.startsWith("invalid"));
    it(`${name}: has both kinds of example`, () => {
      expect(valid.length, "valid example").toBeGreaterThan(0);
      expect(invalid.length, "invalid example").toBeGreaterThan(0);
    });
    for (const f of valid) {
      it(`${name}/${f} validates`, () => {
        for (const doc of loadExample(join(dir, f))) expect(schemas.check(name, doc)).toEqual([]);
      });
    }
    for (const f of invalid) {
      it(`${name}/${f} is rejected with a named field`, () => {
        for (const doc of loadExample(join(dir, f))) {
          const errs = schemas.check(name, doc);
          expect(errs.length).toBeGreaterThan(0);
          for (const e of errs) expect(e).toMatch(/^[^:]+: /);
        }
      });
    }
  }
});

describe("schema hygiene", () => {
  const all = loadSchemas();
  it("every schema declares draft 2020-12 and a versioned $id", () => {
    for (const [name, s] of Object.entries(all) as [string, Record<string, unknown>][]) {
      expect(s.$schema, name).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(s.$id, name).toBe(`https://litmustest.dev/schemas/v1/${name}.json`);
      expect(typeof s.description, name).toBe("string");
    }
  });
  it("rejects a floating model alias and accepts a dated snapshot", () => {
    const v = schemas.ajv.compile({ $ref: "https://litmustest.dev/schemas/v1/common.json#/$defs/model_id" });
    expect(v("claude-sonnet-4-5-20250929")).toBe(true);
    expect(v("claude-sonnet-4-5")).toBe(false);
    expect(v("claude-sonnet-latest")).toBe(false);
  });
  it("names are snake_case", () => {
    const v = schemas.ajv.compile({ $ref: "https://litmustest.dev/schemas/v1/common.json#/$defs/name" });
    for (const ok of ["tone_mismatch", "a", "x9_y"]) expect(v(ok), ok).toBe(true);
    for (const bad of ["Tone", "tone-mismatch", "_x", "9x", ""]) expect(v(bad), bad).toBe(false);
  });
});
