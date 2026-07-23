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
  "Accept-Language": "en-US",
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

// eBay inventory condition enums <-> the numeric condition IDs the metadata
// API reports as allowed per category.
const ID_TO_ENUM = {
  "1000": "NEW",
  "1500": "NEW_OTHER",
  "1750": "NEW_WITH_DEFECTS",
  "2000": "CERTIFIED_REFURBISHED",
  "2500": "SELLER_REFURBISHED",
  "2750": "LIKE_NEW",
  "3000": "USED_EXCELLENT",
  "4000": "USED_VERY_GOOD",
  "5000": "USED_GOOD",
  "6000": "USED_ACCEPTABLE",
  "7000": "FOR_PARTS_OR_NOT_WORKING",
};
const ENUM_TO_ID = Object.fromEntries(Object.entries(ID_TO_ENUM).map(([id, e]) => [e, id]));

// The condition IDs a category accepts (null if it can't be fetched).
export async function allowedConditionIds(accessToken, categoryId) {
  const filter = encodeURIComponent(`categoryIds:{${categoryId}}`);
  const r = await fetch(
    `https://api.ebay.com/sell/metadata/v1/marketplace/${MARKET}/get_item_condition_policies?filter=${filter}`,
    { headers: { Authorization: "Bearer " + accessToken, "Accept-Language": "en-US" } }
  );
  if (!r.ok) return null;
  const d = await r.json();
  const pol = d.itemConditionPolicies?.[0];
  if (!pol) return null;
  return (pol.itemConditions || []).map((c) => String(c.conditionId));
}

// An ordered list of condition enums to try at publish: the metadata-picked
// one first, then any others the category reports, then a standard fallback.
// eBay's condition metadata is unreliable for some categories, so we publish
// with each in turn until one is accepted.
export function conditionCandidates(requested, allowedIds) {
  const out = [];
  const push = (c) => {
    if (c && !out.includes(c)) out.push(c);
  };
  push(requested);
  if (allowedIds) allowedIds.map((id) => ID_TO_ENUM[id]).forEach(push);
  [
    "USED_EXCELLENT",
    "USED_VERY_GOOD",
    "USED_GOOD",
    "USED_ACCEPTABLE",
    "LIKE_NEW",
    "NEW",
    "FOR_PARTS_OR_NOT_WORKING",
  ].forEach(push);
  return out.slice(0, 8);
}

// Pick a condition enum the category accepts, staying close to what was asked.
export function pickCondition(requestedEnum, allowedIds) {
  if (!allowedIds || allowedIds.length === 0) return requestedEnum;
  const reqId = ENUM_TO_ID[requestedEnum];
  if (reqId && allowedIds.includes(reqId)) return requestedEnum;
  const isNew = requestedEnum.startsWith("NEW") || requestedEnum === "LIKE_NEW";
  const usedPref = ["3000", "4000", "5000", "6000", "2750", "7000"];
  const newPref = ["1000", "1500", "1750"];
  const order = isNew ? [...newPref, ...usedPref] : [...usedPref, ...newPref];
  const pickId = order.find((id) => allowedIds.includes(id)) || allowedIds[0];
  return ID_TO_ENUM[pickId] || requestedEnum;
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

// The item specifics ("aspects") a category REQUIRES, with allowed values so
// the app can render the right field (dropdown vs free text).
export async function getRequiredAspects(accessToken, categoryId) {
  const r = await fetch(
    `${TAXONOMY}/category_tree/0/get_item_aspects_for_category?category_id=${categoryId}`,
    { headers: { Authorization: "Bearer " + accessToken, "Accept-Language": "en-US" } }
  );
  if (!r.ok) return [];
  const d = await r.json();
  return (d.aspects || [])
    .filter((a) => a.aspectConstraint?.aspectRequired)
    .map((a) => ({
      name: a.localizedAspectName,
      mode: a.aspectConstraint?.aspectMode || "FREE_TEXT", // SELECTION_ONLY | FREE_TEXT
      values: (a.aspectValues || []).map((v) => v.localizedValue).slice(0, 80),
    }));
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
  // eBay's inventory service can return transient 5xx (errorId 25001), often
  // when its image fetcher hits our photo endpoint cold. Retry a few times.
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${INVENTORY}/inventory_item/${encodeURIComponent(sku)}`, {
      method: "PUT",
      headers: auth(accessToken),
      body: JSON.stringify(item),
    });
    if (r.ok || r.status === 204) return;
    last = `inventory ${r.status}: ${(await r.text()).slice(0, 900)}`;
    if (r.status < 500) break; // real validation error — don't retry
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  throw new Error(last);
}

export async function createOffer(accessToken, offer) {
  const r = await fetch(`${INVENTORY}/offer`, {
    method: "POST",
    headers: auth(accessToken),
    body: JSON.stringify(offer),
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok) return d.offerId;

  // An offer already exists for this SKU (from a prior attempt). eBay returns
  // its id — update that offer with the current data and reuse it.
  const existing = d.errors
    ?.find((e) => e.errorId === 25002)
    ?.parameters?.find((p) => p.name === "offerId")?.value;
  if (existing) {
    const { sku, marketplaceId, format, ...updatable } = offer;
    const u = await fetch(`${INVENTORY}/offer/${existing}`, {
      method: "PUT",
      headers: auth(accessToken),
      body: JSON.stringify(updatable),
    });
    if (!u.ok && u.status !== 204) {
      throw new Error(`offer-update ${u.status}: ${(await u.text()).slice(0, 600)}`);
    }
    return existing;
  }
  throw new Error(`offer ${r.status}: ${JSON.stringify(d).slice(0, 700)}`);
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
