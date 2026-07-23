// eBay Sell API helpers (listing side). Step 2a only needs the business
// policies; the publish pipeline will grow here in later steps.

const ACCOUNT = "https://api.ebay.com/sell/account/v1";
const INVENTORY = "https://api.ebay.com/sell/inventory/v1";
const TAXONOMY = "https://api.ebay.com/commerce/taxonomy/v1";
const MARKET = "EBAY_US";

const auth = (accessToken) => ({
  Authorization: "Bearer " + accessToken,
  "Content-Type": "application/json",
  "Content-Language": "en-US",
});

// Map free-text condition to eBay's inventory condition enum.
export function ebayCondition(text) {
  const t = (text || "").toLowerCase();
  if (/\bnew\b|sealed|mint(?!\s*minus)/.test(t)) return "NEW";
  if (/excellent|near ?mint|\bnm\b/.test(t)) return "USED_EXCELLENT";
  if (/very good|\bvg\b/.test(t)) return "USED_VERY_GOOD";
  if (/parts|broken|not working|repair|for parts/.test(t)) return "FOR_PARTS_OR_NOT_WORKING";
  if (/fair|acceptable|poor/.test(t)) return "USED_ACCEPTABLE";
  if (/good/.test(t)) return "USED_GOOD";
  return "USED_GOOD";
}

// Suggest the best eBay leaf category from the listing title.
export async function suggestCategory(accessToken, title) {
  const r = await fetch(
    `${TAXONOMY}/category_tree/0/get_category_suggestions?q=${encodeURIComponent(title)}`,
    { headers: { Authorization: "Bearer " + accessToken } }
  );
  if (!r.ok) return null;
  const d = await r.json();
  return d.categorySuggestions?.[0]?.category?.categoryId || null;
}

// Create (or reuse) a ship-from inventory location keyed per user.
export async function ensureLocation(accessToken, key, postalCode) {
  const r = await fetch(`${INVENTORY}/location/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: auth(accessToken),
    body: JSON.stringify({
      location: { address: { country: "US", postalCode } },
      merchantLocationStatus: "ENABLED",
      locationTypes: ["WAREHOUSE"],
    }),
  });
  if (r.ok || r.status === 204 || r.status === 409) return;
  // eBay returns 400 errorId 25803 ("already exists") when the key is taken —
  // that's exactly what we want, so treat it as success.
  const text = await r.text();
  if (/2580[0-9]/.test(text) || /already exists/i.test(text)) return;
  throw new Error(`location ${r.status}: ${text.slice(0, 200)}`);
}

export async function putInventoryItem(accessToken, sku, item) {
  const r = await fetch(`${INVENTORY}/inventory_item/${encodeURIComponent(sku)}`, {
    method: "PUT",
    headers: auth(accessToken),
    body: JSON.stringify(item),
  });
  if (!r.ok && r.status !== 204) {
    throw new Error(`inventory ${r.status}: ${(await r.text()).slice(0, 900)}`);
  }
}

export async function createOffer(accessToken, offer) {
  const r = await fetch(`${INVENTORY}/offer`, {
    method: "POST",
    headers: auth(accessToken),
    body: JSON.stringify(offer),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`offer ${r.status}: ${JSON.stringify(d).slice(0, 700)}`);
  return d.offerId;
}

export async function publishOffer(accessToken, offerId) {
  const r = await fetch(`${INVENTORY}/offer/${offerId}/publish`, {
    method: "POST",
    headers: auth(accessToken),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`publish ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  return d.listingId;
}

async function getList(kind, listKey, idKey, accessToken) {
  const r = await fetch(`${ACCOUNT}/${kind}?marketplace_id=${MARKET}`, {
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (!r.ok) {
    return { error: `${kind} ${r.status}: ${(await r.text()).slice(0, 150)}` };
  }
  const data = await r.json();
  return {
    items: (data[listKey] || []).map((p) => ({ id: p[idKey], name: p.name })),
  };
}

// Whether the eBay account is fully registered to sell (and its selling limit).
export async function getSellerPrivileges(accessToken) {
  const r = await fetch(`${ACCOUNT}/privilege`, {
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (!r.ok) return { error: `privilege ${r.status}: ${(await r.text()).slice(0, 150)}` };
  const d = await r.json();
  return { registered: !!d.sellerRegistrationCompleted, sellingLimit: d.sellingLimit || null };
}

// The three policy types eBay requires before an item can be published.
export async function getBusinessPolicies(accessToken) {
  const [payment, fulfillment, ret] = await Promise.all([
    getList("payment_policy", "paymentPolicies", "paymentPolicyId", accessToken),
    getList("fulfillment_policy", "fulfillmentPolicies", "fulfillmentPolicyId", accessToken),
    getList("return_policy", "returnPolicies", "returnPolicyId", accessToken),
  ]);
  return { payment, fulfillment, return: ret };
}
