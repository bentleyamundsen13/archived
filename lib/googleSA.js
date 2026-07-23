// Service-account helpers using ONLY Node's crypto + fetch — no firebase-admin
// (its gRPC layer doesn't bundle reliably on Vercel). Mints a Google OAuth2
// access token for the Firestore REST API by signing a JWT with the service
// account key in FIREBASE_SERVICE_ACCOUNT.

import crypto from "crypto";

let cached = null; // { token, exp }

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
  return JSON.parse(raw);
}

export function projectId() {
  return serviceAccount().project_id;
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

export async function googleAccessToken() {
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;
  const key = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const signingInput =
    b64url({ alg: "RS256", typ: "JWT" }) +
    "." +
    b64url({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(signingInput)
    .sign(key.private_key, "base64url");
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${signature}`,
    }).toString(),
  });
  if (!resp.ok) {
    throw new Error("Google token exchange failed: " + (await resp.text()).slice(0, 150));
  }
  const data = await resp.json();
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return cached.token;
}
