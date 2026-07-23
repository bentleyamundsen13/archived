// GET /api/ebay-callback?code=...&state=...
// eBay redirects the user here after they approve. We exchange the code for a
// refresh token, store it server-side (only the Admin SDK can read it), flag
// the user as connected, then bounce back into the app.

import { setDocRest } from "../../lib/firestoreRest.js";
import { verifyState, exchangeCode, ebayUsername } from "../../lib/ebayAuth.js";

export default async (req) => {
  const url = new URL(req.url);
  const back = (status) =>
    new Response(null, { status: 302, headers: { Location: url.origin + "/?ebay=" + status } });

  if (url.searchParams.get("error")) return back("declined");
  const code = url.searchParams.get("code");
  const uid = verifyState(url.searchParams.get("state"));
  if (!code || !uid) return back("error");

  try {
    const tok = await exchangeCode(code);
    const username = await ebayUsername(tok.access_token);
    // Secret refresh token — server-only collection no client rule exposes.
    await setDocRest(`ebayTokens/${uid}`, {
      refresh_token: tok.refresh_token,
      refresh_token_expires: Date.now() + (tok.refresh_token_expires_in || 0) * 1000,
      updated: Date.now(),
    });
    // Public, client-readable flag so the UI can show "Connected".
    await setDocRest(`users/${uid}`, { ebayConnected: true, ebayUser: username || null });
    return back("connected");
  } catch {
    return back("error");
  }
};
