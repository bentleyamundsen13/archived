// Minimal Firestore writes over the REST API (no firebase-admin). Uses a
// service-account access token; runs anywhere, no native/gRPC deps.

import { googleAccessToken, projectId } from "./googleSA.js";

const docBase = () =>
  `https://firestore.googleapis.com/v1/projects/${projectId()}/databases/(default)/documents`;

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number")
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}

function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toValue(v);
  return fields;
}

function fromValue(v) {
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromValue);
  if ("mapValue" in v) return fromFields(v.mapValue.fields || {});
  return null;
}

function fromFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) obj[k] = fromValue(v);
  return obj;
}

// Read a document (path like "ebayTokens/uid"). Returns {} if it doesn't exist.
export async function getDocRest(path) {
  const token = await googleAccessToken();
  const resp = await fetch(`${docBase()}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 404) return {};
  if (!resp.ok) throw new Error("Firestore read failed: " + (await resp.text()).slice(0, 150));
  const data = await resp.json();
  return fromFields(data.fields || {});
}

// Merge-set the given fields on a document (path like "users/uid").
export async function setDocRest(path, obj) {
  const token = await googleAccessToken();
  const mask = Object.keys(obj)
    .map((k) => "updateMask.fieldPaths=" + encodeURIComponent(k))
    .join("&");
  const resp = await fetch(`${docBase()}/${path}?${mask}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFields(obj) }),
  });
  if (!resp.ok) {
    throw new Error("Firestore write failed: " + (await resp.text()).slice(0, 150));
  }
}
