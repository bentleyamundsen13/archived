// Netlify Function: /.netlify/functions/price?q=search+terms&type=collection+type
// Routes to the best marketplace for the collection type and returns a
// market value AND a product image when available:
//   records/vinyl  -> Discogs   (DISCOGS_TOKEN)
//   guitars/gear   -> Reverb    (REVERB_TOKEN)
//   everything     -> eBay      (EBAY_CLIENT_ID + EBAY_CLIENT_SECRET)

const UA = "ArchivedApp/1.0 (collection tracker)";

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function trimOutliers(prices) {
  if (prices.length >= 10) {
    const cut = Math.floor(prices.length * 0.1);
    return prices.slice(cut, prices.length - cut);
  }
  return prices;
}

/* ---------------- Google Custom Search (product images) ---------------- */
// Free tier is 100 searches/day, so exactly one call per request, no retries.

async function googleImage(q, key, cx) {
  const params = new URLSearchParams({
    key,
    cx,
    searchType: "image",
    num: "5",
    q: q + " product photo",
  });
  const resp = await fetch("https://www.googleapis.com/customsearch/v1?" + params);
  if (!resp.ok) return null;
  const items = (await resp.json()).items || [];
  const hit = items.find((it) => typeof it.link === "string" && it.link.startsWith("https://"));
  return hit?.link || null;
}

/* ---------------- Discogs ---------------- */

async function discogsPrice(q, token) {
  const search = await fetch(
    "https://api.discogs.com/database/search?type=release&per_page=3&q=" +
      encodeURIComponent(q) + "&token=" + token,
    { headers: { "User-Agent": UA } }
  );
  if (!search.ok) return null;
  const found = (await search.json()).results?.[0];
  if (!found?.id) return null;
  const image = found.cover_image || found.thumb || null;

  const stats = await fetch(
    `https://api.discogs.com/marketplace/stats/${found.id}?token=${token}`,
    { headers: { "User-Agent": UA } }
  );
  if (!stats.ok) return image ? { value: null, image } : null;
  const s = await stats.json();
  const low = Number(s?.lowest_price?.value);
  if (!Number.isFinite(low) || low <= 0) {
    return image ? { value: null, image } : null;
  }
  const n = s.num_for_sale || 1;
  return {
    value: Math.round(low),
    sample_size: n,
    label: `Discogs · ${n} for sale`,
    image,
  };
}

/* ---------------- Reverb ---------------- */

async function reverbPrice(q, token) {
  const resp = await fetch(
    "https://api.reverb.com/api/listings?per_page=50&query=" + encodeURIComponent(q),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Accept-Version": "3.0",
        Accept: "application/hal+json",
        "User-Agent": UA,
      },
    }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  const listings = data.listings || [];
  const image = listings[0]?.photos?.[0]?._links?.thumbnail?.href || null;
  let prices = listings
    .filter((l) => l?.price?.currency === "USD")
    .map((l) => Number(l.price.amount))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (prices.length < 3) return image ? { value: null, image } : null;
  prices = trimOutliers(prices);
  return {
    value: Math.round(median(prices)),
    sample_size: prices.length,
    label: `Reverb · ${prices.length} listings`,
    image,
  };
}

/* ---------------- eBay ---------------- */

let ebayToken = null;
let ebayTokenExpires = 0;

async function getEbayToken(id, secret) {
  if (ebayToken && Date.now() < ebayTokenExpires - 60_000) return ebayToken;
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
  ebayToken = data.access_token;
  ebayTokenExpires = Date.now() + (data.expires_in || 7200) * 1000;
  return ebayToken;
}

async function ebayPrice(q, id, secret) {
  const token = await getEbayToken(id, secret);
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
  if (!search.ok) return null;
  const data = await search.json();
  const items = data.itemSummaries || [];
  const image = items[0]?.image?.imageUrl || items[0]?.thumbnailImages?.[0]?.imageUrl || null;
  let prices = items
    .map((it) => Number(it?.price?.value))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (prices.length < 3) return image ? { value: null, image } : null;
  prices = trimOutliers(prices);
  return {
    value: Math.round(median(prices)),
    sample_size: prices.length,
    label: `eBay · ${prices.length} listings`,
    image,
  };
}

/* ---------------- Router ---------------- */

export default async (req) => {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const type = (url.searchParams.get("type") || "").toLowerCase();
  if (!q) {
    return new Response(JSON.stringify({ error: "missing q" }), { status: 400 });
  }

  const discogsToken = process.env.DISCOGS_TOKEN;
  const reverbToken = process.env.REVERB_TOKEN;
  const ebayId = process.env.EBAY_CLIENT_ID;
  const ebaySecret = process.env.EBAY_CLIENT_SECRET;
  const googleKey = process.env.GOOGLE_SEARCH_API_KEY;
  const googleCx = process.env.GOOGLE_CSE_ID;

  // Google image lookup — never allowed to break pricing.
  let googleImg = null;
  if (googleKey && googleCx) {
    try {
      googleImg = await googleImage(q, googleKey, googleCx);
    } catch {}
  }

  if (url.searchParams.get("imageonly")) {
    return new Response(JSON.stringify({ image: googleImg }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const isRecords = /record|vinyl|lp|album|cd|cassette/.test(type);
  const isGear = /guitar|bass|amp|pedal|synth|drum|keyboard|music gear|instrument/.test(type);

  const attempts = [];
  if (isRecords && discogsToken) attempts.push(() => discogsPrice(q, discogsToken));
  if (isGear && reverbToken) attempts.push(() => reverbPrice(q, reverbToken));
  if (ebayId && ebaySecret) attempts.push(() => ebayPrice(q, ebayId, ebaySecret));

  if (attempts.length === 0) {
    if (googleImg) {
      return new Response(JSON.stringify({ value: null, image: googleImg }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "pricing not configured" }), {
      status: 501,
    });
  }

  let firstImage = null;
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result) {
        if (!firstImage && result.image) firstImage = result.image;
        if (result.value) {
          result.image = googleImg || result.image || firstImage;
          return new Response(JSON.stringify(result), {
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    } catch {}
  }

  return new Response(JSON.stringify({ value: null, image: googleImg || firstImage }), {
    headers: { "Content-Type": "application/json" },
  });
};
