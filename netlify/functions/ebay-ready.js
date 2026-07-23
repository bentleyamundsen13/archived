// POST /api/ebay-ready  { idToken }
// Confirms the stored eBay connection can actually drive the Sell API: reads
// the refresh token, exchanges it for an access token, and lists the user's
// business policies (which must exist before anything can be published).

import { verifyFirebaseIdToken } from "../../lib/verifyFirebaseToken.js";
import { getDocRest } from "../../lib/firestoreRest.js";
import { refreshUserToken } from "../../lib/ebayAuth.js";
import { getBusinessPolicies, getSellerPrivileges } from "../../lib/ebaySell.js";

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default async (req) => {
  try {
    const { idToken } = await req.json();
    if (!idToken) return json({ error: "Missing idToken" }, 400);
    const uid = await verifyFirebaseIdToken(idToken);

    const tok = await getDocRest(`ebayTokens/${uid}`);
    if (!tok.refresh_token) return json({ connected: false, error: "No eBay connection found." }, 200);

    const accessToken = await refreshUserToken(tok.refresh_token);
    const [policies, privileges] = await Promise.all([
      getBusinessPolicies(accessToken),
      getSellerPrivileges(accessToken),
    ]);
    return json({ connected: true, policies, privileges });
  } catch (e) {
    return json({ error: e?.message || String(e) }, 400);
  }
};
