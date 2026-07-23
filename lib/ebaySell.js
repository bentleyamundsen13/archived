// eBay Sell API helpers (listing side). Step 2a only needs the business
// policies; the publish pipeline will grow here in later steps.

const ACCOUNT = "https://api.ebay.com/sell/account/v1";
const MARKET = "EBAY_US";

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
