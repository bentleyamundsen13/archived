// POST /api/ebay-connect  { idToken }
// Verifies the signed-in user, then returns the eBay authorization URL the
// client should redirect to so the user can grant selling permission.

import { adminAuth } from "../../lib/firebaseAdmin.js";
import { signState, authorizeUrl } from "../../lib/ebayAuth.js";

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default async (req) => {
  try {
    const { idToken } = await req.json();
    if (!idToken) return json({ error: "Missing idToken" }, 400);
    const decoded = await adminAuth().verifyIdToken(idToken);
    const url = authorizeUrl(signState(decoded.uid));
    return json({ url });
  } catch (e) {
    return json({ error: "Couldn't start eBay connect: " + (e?.message || String(e)) }, 400);
  }
};
