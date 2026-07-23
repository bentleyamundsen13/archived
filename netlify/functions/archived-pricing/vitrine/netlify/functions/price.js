// Netlify Function: /.netlify/functions/price?q=search+terms
// Looks up live eBay listings and returns the median asking price.
//
// Needs two env vars (from a production keyset at developer.ebay.com):
//   EBAY_CLIENT_ID      (eBay calls this "App ID")
//   EBAY_CLIENT_SECRET  (eBay calls this "Cert ID")
// Until they're set, this returns 501 and the app just keeps using
// AI estimates — nothing breaks.
//
// Honest limitation: eBay's public Browse API returns ACTIVE listing
// (asking) prices, not sold prices. Median asking price is a solid
// real-world number but skews slightly optimistic.

let cachedToken = null;
let tokenExpires = 0;

async function getToken(id, secret) {
  if (cachedToken && Date.now() < tokenExpires - 60_000) return cachedToken;

  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    },
    body: "grant_type=client_credentials&scope=" +
      encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!resp.ok) throw new Error(`eBay auth failed (${resp.status})`);
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpires = Date.now() + (data.expires_in || 7200) * 1000;
  return cachedToken;
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export default async (req) => {
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) {
    return new Response(JSON.stringify({ error: "pricing not configured" }), {
      status: 501,
    });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  if (!q) {
    return new Response(JSON.stringify({ error: "missing q" }), { status: 400 });
  }

  try {
    const token = await getToken(id, secret);

    const search = await fetch(
      "https://api.ebay.com/buy/browse/v1/item_summary/search?limit=50&q=" +
        encodeURIComponent(q),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
      }
    );
    if (!search.ok) {
      const detail = (await search.text()).slice(0, 200);
      return new Response(
        JSON.stringify({ error: `eBay search failed (${search.status}): ${detail}` }),
        { status: 502 }
      );
    }

    const data = await search.json();
    let prices = (data.itemSummaries || [])
      .map((it) => Number(it?.price?.value))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);

    if (prices.length < 3) {
      // Too few listings to trust a median
      return new Response(
        JSON.stringify({ median: null, sample_size: prices.length }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Trim the cheapest/priciest 10% to cut out parts, fakes, and dreamers
    if (prices.length >= 10) {
      const cut = Math.floor(prices.length * 0.1);
      prices = prices.slice(cut, prices.length - cut);
    }

    return new Response(
      JSON.stringify({
        median: Math.round(median(prices)),
        sample_size: prices.length,
        query: q,
        source: "ebay_active_listings",
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err).slice(0, 200) }), {
      status: 500,
    });
  }
};
