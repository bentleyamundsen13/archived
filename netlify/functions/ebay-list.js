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
  allowedConditionIds,
  pickCondition,
  conditionCandidates,
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
    const { idToken, cid, itemId, photoIds, title, price, condition, description, brand, zip, aspects } = b;
    if (!title || !price || !zip) return json({ error: "Missing title, price, or ZIP." }, 400);

    // User-entered required item specifics -> eBay's { name: [value] } shape.
    const productAspects = {};
    if (brand) productAspects.Brand = [String(brand)];
    if (aspects && typeof aspects === "object") {
      for (const [k, v] of Object.entries(aspects)) {
        if (v != null && String(v).trim()) productAspects[k] = [String(v).trim()];
      }
    }

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

    step = "condition";
    const allowedIds = await allowedConditionIds(accessToken, categoryId);
    const finalCondition = pickCondition(ebayCondition(condition), allowedIds);

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
    const inventoryBody = {
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition: finalCondition,
      product: {
        title: String(title).slice(0, 80),
        description: String(description || title).slice(0, 4000),
        imageUrls,
        ...(Object.keys(productAspects).length ? { aspects: productAspects } : {}),
      },
    };
    await putInventoryItem(accessToken, sku, inventoryBody);

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

    // Publish, cycling through conditions until eBay accepts one — its
    // per-category condition metadata isn't always right, so we just try.
    step = "publish";
    const candidates = conditionCandidates(finalCondition, allowedIds);
    let listingId = null;
    let lastErr = null;
    for (const cond of candidates) {
      if (cond !== inventoryBody.condition) {
        inventoryBody.condition = cond;
        await putInventoryItem(accessToken, sku, inventoryBody);
      }
      try {
        listingId = await publishOffer(accessToken, offerId);
        break;
      } catch (e) {
        lastErr = e;
        // Keep trying only for condition-related rejections.
        if (!/condition|2505\d|2502[01]/i.test(String(e?.message || ""))) throw e;
      }
    }
    if (!listingId) throw lastErr || new Error("publish failed");
    return json({ ok: true, listingId, url: `https://www.ebay.com/itm/${listingId}` });
  } catch (e) {
    return json({ error: `Failed at "${step}": ${e?.message || String(e)}` }, 400);
  }
};
