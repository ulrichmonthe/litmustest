import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const SCHEMA_BASE = "https://litmustest.dev/schemas/v1/";

/** Every file type under evals/, by schema name (the file name without .json). */
export type SchemaName =
  | "config" | "failure_mode" | "task" | "check.code" | "check.judge" | "check.outcome"
  | "check.transcript" | "reference_solution" | "judge" | "calibration" | "label" | "suite"
  | "run_summary" | "trace" | "trace.jsonl_adapter" | "batch" | "glossary";

/** Where the schema files live: inside the published package, or at the repo root in development. */
export function schemasDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "schemas"), join(here, "..", "..", "..", "schemas")];
  for (const c of candidates) if (existsSync(join(c, "common.json"))) return c;
  throw new Error(`schemas directory not found; looked in ${candidates.join(", ")}`);
}

export function loadSchemas(dir = schemasDir()): Record<string, object> {
  const out: Record<string, object> = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    out[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(dir, f), "utf8"));
  }
  return out;
}

export class SchemaSet {
  readonly ajv: Ajv2020;
  readonly schemas: Record<string, object>;
  constructor(dir?: string) {
    this.schemas = loadSchemas(dir);
    this.ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true, useDefaults: false });
    addFormats.default(this.ajv);
    for (const s of Object.values(this.schemas)) this.ajv.addSchema(s);
  }
  validator(name: SchemaName | string): ValidateFunction {
    const v = this.ajv.getSchema(SCHEMA_BASE + name + ".json");
    if (!v) throw new Error(`unknown schema: ${name}`);
    return v;
  }
  /** Returns [] when valid, otherwise one message per failing keyword. */
  check(name: SchemaName | string, data: unknown): string[] {
    const v = this.validator(name);
    if (v(data)) return [];
    return (v.errors ?? []).map((e) => {
      const where = e.instancePath ? e.instancePath.replace(/^\//, "").replace(/\//g, ".") : "(root)";
      const extra = e.keyword === "additionalProperties" ? ` '${(e.params as { additionalProperty: string }).additionalProperty}'` : "";
      return `${where}: ${e.message}${extra}`;
    });
  }
}
