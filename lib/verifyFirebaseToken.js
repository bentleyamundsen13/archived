// Verify a Firebase ID token without firebase-admin: check the RS256 signature
// against Google's public x509 certs and validate the standard claims. Returns
// the uid (sub) on success, throws otherwise.

import crypto from "crypto";
import { projectId } from "./googleSA.js";

const CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let certCache = null; // { keys, exp }

async function googleCerts() {
  if (certCache && Date.now() < certCache.exp) return certCache.keys;
  const resp = await fetch(CERTS_URL);
  if (!resp.ok) throw new Error("Couldn't fetch Google certs");
  const keys = await resp.json();
  const m = (resp.headers.get("cache-control") || "").match(/max-age=(\d+)/);
  certCache = { keys, exp: Date.now() + (m ? Number(m[1]) : 3600) * 1000 };
  return keys;
}

export async function verifyFirebaseIdToken(idToken) {
  const parts = (idToken || "").split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token");
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  const pid = projectId();
  const now = Math.floor(Date.now() / 1000);

  if (payload.aud !== pid) throw new Error("Token audience mismatch");
  if (payload.iss !== `https://securetoken.google.com/${pid}`)
    throw new Error("Token issuer mismatch");
  if (!payload.sub) throw new Error("Token has no subject");
  if (payload.exp && payload.exp < now) throw new Error("Token expired");

  const pem = (await googleCerts())[header.kid];
  if (!pem) throw new Error("Unknown signing key");
  const ok = crypto
    .createVerify("RSA-SHA256")
    .update(`${h}.${p}`)
    .verify(pem, s, "base64url");
  if (!ok) throw new Error("Invalid token signature");

  return payload.sub;
}
