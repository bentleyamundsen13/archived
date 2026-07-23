// POST /api/ebay-prep  { idToken, title }
// Suggests the eBay category for a title and returns the item specifics that
// category REQUIRES, so the listing form can show fields for them.

import { verifyFirebaseIdToken } from "../../lib/verifyFirebaseToken.js";
import { getDocRest } from "../../lib/firestoreRest.js";
import { refreshUserToken } from "../../lib/ebayAuth.js";
import { suggestCategory, getRequiredAspects } from "../../lib/ebaySell.js";

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

export default async (req) => {
  try {
    const { idToken, title } = await req.json();
    const uid = await verifyFirebaseIdToken(idToken);
    if (!title || !title.trim()) return json({ categoryId: null, aspects: [] });

    const tok = await getDocRest(`ebayTokens/${uid}`);
    if (!tok.refresh_token) return json({ error: "eBay isn't connected." }, 400);
    const accessToken = await refreshUserToken(tok.refresh_token);

    const categoryId = await suggestCategory(accessToken, title.trim());
    if (!categoryId) return json({ categoryId: null, aspects: [] });
    const aspects = await getRequiredAspects(accessToken, categoryId);
    return json({ categoryId, aspects });
  } catch (e) {
    return json({ error: e?.message || String(e) }, 400);
  }
};
