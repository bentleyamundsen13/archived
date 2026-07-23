// eBay OAuth (user consent) helpers, shared by the connect + callback
// functions. The app authenticates to eBay with the client id/secret already
// in env; the USER grants selling permission via the authorize URL, and eBay
// returns a code we exchange for a refresh token stored per user.

import crypto from "crypto";

// Your registered redirect (RuName). Not a secret — it only names where eBay
// sends the user back. The actual accepted URL is configured in the dev portal.
export const EBAY_RUNAME = "Bentley_Amundse-BentleyA-archiv-wzohxj";

// Scopes the app asks the user to grant: create/manage listings (inventory),
// read/use business policies (account), and read their username (identity).
export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
];

const stateSecret = () => process.env.EBAY_CLIENT_SECRET || "dev-secret";

// A tamper-proof, short-lived state so the callback can trust which user it's
// for (CSRF protection + user binding without server-side session storage).
export function signState(uid) {
  const payload = Buffer.from(
    JSON.stringify({ uid, exp: Date.now() + 10 * 60 * 1000 })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(state) {
  if (!state || !state.includes(".")) return null;
  const [payload, sig] = state.split(".");
  const expected = crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.uid || Date.now() > data.exp) return null;
    return data.uid;
  } catch {
    return null;
  }
}

export function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.EBAY_CLIENT_ID || "",
    response_type: "code",
    redirect_uri: EBAY_RUNAME,
    scope: EBAY_SCOPES.join(" "),
    state,
    prompt: "login",
  });
  return "https://auth.ebay.com/oauth2/authorize?" + params.toString();
}

// Trade the one-time authorization code for tokens.
export async function exchangeCode(code) {
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: EBAY_RUNAME,
    }).toString(),
  });
  if (!resp.ok) {
    throw new Error(`eBay token exchange failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  }
  return resp.json(); // { access_token, refresh_token, expires_in, refresh_token_expires_in }
}

// Trade a stored refresh token for a fresh access token (used for Sell calls).
export async function refreshUserToken(refreshToken) {
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: EBAY_SCOPES.join(" "),
    }).toString(),
  });
  if (!resp.ok) {
    throw new Error(`eBay token refresh failed (${resp.status}): ${(await resp.text()).slice(0, 150)}`);
  }
  return (await resp.json()).access_token;
}

// Best-effort lookup of the connected eBay username for display.
export async function ebayUsername(accessToken) {
  try {
    const r = await fetch("https://apiz.ebay.com/commerce/identity/v1/user/", {
      headers: { Authorization: "Bearer " + accessToken },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.username || d.userId || null;
  } catch {
    return null;
  }
}
