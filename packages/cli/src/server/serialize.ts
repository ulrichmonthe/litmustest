// Turn structured data from the dashboard into file text with the smallest diff against what is on disk.
// YAML: the existing document is patched in place, so unchanged keys keep their order, style and comments.
import { isDeepStrictEqual } from "node:util";
import { Document, isMap, isScalar, parseDocument, stringify as yaml } from "yaml";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function serialize(rel: string, data: unknown, before?: string): string {
  if (rel.endsWith(".json")) return JSON.stringify(before === undefined ? data : keepOrder(safeJson(before), data), null, 2) + "\n";
  if (before === undefined || !isObj(data)) return yaml(data, { lineWidth: 0 });
  const doc = parseDocument(before);
  if (doc.errors.length || !isMap(doc.contents)) return yaml(data, { lineWidth: 0 });
  patch(doc, doc.contents as never, data);
  const out = doc.toString({ lineWidth: 0 });
  // An edit that changes nothing must not change the bytes.
  return isDeepStrictEqual(doc.toJS(), parseDocument(before).toJS()) ? before : out;
}

function patch(doc: Document, map: { items: { key: unknown; value: unknown }[]; get(k: string, keep: true): unknown; set(k: string, v: unknown): void; delete(k: string): boolean }, data: Obj): void {
  const keyOf = (k: unknown) => String(isScalar(k) ? k.value : k);
  for (const k of map.items.map((p) => keyOf(p.key))) if (!(k in data)) map.delete(k);
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    const node = map.get(k, true);
    const cur = node === undefined ? undefined : isScalar(node) ? node.value : (node as { toJSON(): unknown }).toJSON();
    if (node !== undefined && isDeepStrictEqual(cur, v)) continue;
    if (isMap(node) && isObj(v)) { patch(doc, node as never, v); continue; }
    const fresh = doc.createNode(v);
    if (isScalar(node) && isScalar(fresh) && typeof v === "string" && node.type) fresh.type = node.type; // keep >- or | style
    map.set(k, fresh);
  }
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return undefined; } }
/** Keep the existing key order for keys that stay; new keys go at the end. */
function keepOrder(old: unknown, data: unknown): unknown {
  if (!isObj(old) || !isObj(data)) return data;
  const out: Obj = {};
  for (const k of Object.keys(old)) if (k in data) out[k] = keepOrder(old[k], data[k]);
  for (const k of Object.keys(data)) if (!(k in out)) out[k] = data[k];
  return out;
}
