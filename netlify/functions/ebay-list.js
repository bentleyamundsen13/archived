// POST /api/ebay-list
// Publishes an owned item as a live eBay listing on the user's account:
// inventory item -> offer -> publish, using their business policies, the
// item's photos (served by /api/item-image), and a suggested category.

import { verifyFirebaseIdToken } from "../../lib/verifyFirebaseToken.js";
import { getDocRest } from "../../lib/firestoreRest.js";
import { refreshUserToken } from "../../lib/ebayAuth.js";
import {
  getBusinessPolicies,
  suggestCategory,
  ensureLocation,
  putInventoryItem,
  createOffer,
  publishOffer,
  ebayCondition,
} from "../../lib/ebaySell.js";

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

export default async (req) => {
  let step = "start";
  try {
    const b = await req.json();
    const { idToken, cid, itemId, photoIds, title, price, condition, description, brand, zip } = b;
    if (!title || !price || !zip) return json({ error: "Missing title, price, or ZIP." }, 400);

    step = "auth";
    const uid = await verifyFirebaseIdToken(idToken);

    step = "token";
    const tok = await getDocRest(`ebayTokens/${uid}`);
    if (!tok.refresh_token) return json({ error: "eBay isn't connected. Connect it in the You tab." }, 400);
    const accessToken = await refreshUserToken(tok.refresh_token);

    step = "policies";
    const pol = await getBusinessPolicies(accessToken);
    const pay = pol.payment.items?.[0]?.id;
    const ship = pol.fulfillment.items?.[0]?.id;
    const ret = pol.return.items?.[0]?.id;
    if (!pay || !ship || !ret)
      return json({ error: "You're missing a payment, shipping, or return policy on eBay." }, 400);

    step = "category";
    const categoryId = await suggestCategory(accessToken, title);
    if (!categoryId) return json({ error: "Couldn't match this to an eBay category — try a clearer title." }, 400);

    step = "images";
    const origin = new URL(req.url).origin;
    const imageUrls = (photoIds || [])
      .map(
        (p) =>
          `${origin}/api/item-image?c=${encodeURIComponent(cid)}&i=${encodeURIComponent(
            itemId
          )}&p=${encodeURIComponent(p)}`
      )
      .slice(0, 12);
    if (imageUrls.length === 0) return json({ error: "Add at least one photo before listing." }, 400);

    step = "location";
    const locKey = "archived-" + uid.slice(0, 12);
    await ensureLocation(accessToken, locKey, String(zip).trim());

    step = "inventory";
    const sku = "arch-" + String(itemId).slice(0, 30);
    await putInventoryItem(accessToken, sku, {
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition: ebayCondition(condition),
      product: {
        title: String(title).slice(0, 80),
        description: String(description || title).slice(0, 4000),
        imageUrls,
        ...(brand ? { aspects: { Brand: [String(brand)] } } : {}),
      },
    });

    step = "offer";
    const offerId = await createOffer(accessToken, {
      sku,
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      availableQuantity: 1,
      categoryId,
      listingDescription: String(description || title).slice(0, 4000),
      listingPolicies: { paymentPolicyId: pay, fulfillmentPolicyId: ship, returnPolicyId: ret },
      pricingSummary: { price: { value: Number(price).toFixed(2), currency: "USD" } },
      merchantLocationKey: locKey,
    });

    step = "publish";
    const listingId = await publishOffer(accessToken, offerId);
    return json({ ok: true, listingId, url: `https://www.ebay.com/itm/${listingId}` });
  } catch (e) {
    return json({ error: `Failed at "${step}": ${e?.message || String(e)}` }, 400);
  }
};
