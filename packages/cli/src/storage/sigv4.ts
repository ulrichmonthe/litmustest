// AWS Signature Version 4 for S3-style object stores, over plain fetch. No SDK. Also signs for Google Cloud Storage's
// S3-compatible XML API (HMAC keys, region "auto"). Headers are signed as given, plus host, x-amz-date and the payload hash.
import { createHash, createHmac } from "node:crypto";

export interface SigV4Input { method: string; url: string; headers?: Record<string, string>; body?: string; region: string; service?: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string; now?: Date }
const sha = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
const hmac = (key: string | Buffer, d: string) => createHmac("sha256", key).update(d).digest();
/** RFC 3986 encoding, the way SigV4 wants it: everything but unreserved characters. */
export const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** An object key as a URL path: each segment encoded, slashes kept. */
export const encodeKey = (key: string) => key.split("/").map(uriEncode).join("/");

/** The headers to send, Authorization included. The URL's path must already be encoded (encodeKey). */
export function signV4(i: SigV4Input): Record<string, string> {
  const u = new URL(i.url); const service = i.service ?? "s3"; const now = i.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); const date = amzDate.slice(0, 8);
  const payloadHash = sha(i.body ?? "");
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(i.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")])), host: u.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...(i.sessionToken ? { "x-amz-security-token": i.sessionToken } : {}) };
  const names = Object.keys(headers).sort();
  const query = [...u.searchParams.entries()].map(([k, v]) => [uriEncode(k), uriEncode(v)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [i.method.toUpperCase(), u.pathname || "/", query, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, date), i.region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const { host: _host, ...send } = headers; void _host; // fetch sets Host itself
  return { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}
