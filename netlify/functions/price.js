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

/* ---------------- SerpAPI Google Images (product images) ---------------- */
// Free tier is 100 searches/MONTH, so exactly one call per request, no retries.
// We prefer the gstatic thumbnail over the original image: originals live on
// retailer sites that often block hotlinking, while gstatic always renders,
// and the app only shows small thumbs anyway.

async function serpApiImage(q, key) {
  const params = new URLSearchParams({
    engine: "google_images",
    api_key: key,
    num: "5",
    q: q + " product photo",
  });
  const resp = await fetch("https://serpapi.com/search.json?" + params);
  if (!resp.ok) return null;
  const results = (await resp.json()).images_results || [];
  for (const r of results.slice(0, 5)) {
    const pick = [r.thumbnail, r.original].find(
      (u) => typeof u === "string" && u.startsWith("https://")
    );
    if (pick) return pick;
  }
  return null;
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

/* ---------------- eBay search (wishlist) ---------------- */
// Returns a LIST of matching eBay items (title, price, image, listing link)
// for the user to pick from — used by the wishlist search. Buyers browsing
// and saving items that link back to eBay is an intended use of the API.

// Map our simple buying filter to eBay's buyingOptions filter.
function buyingFilter(buying) {
  if (buying === "auction") return "&filter=" + encodeURIComponent("buyingOptions:{AUCTION}");
  if (buying === "fixed") return "&filter=" + encodeURIComponent("buyingOptions:{FIXED_PRICE}");
  return "";
}

// Normalize an eBay itemSummary/item into the shape our wishlist UI uses.
// For auctions the "price" is the current bid; for fixed-price it's the ask.
function shapeEbayItem(it) {
  const opts = it.buyingOptions || [];
  const isAuction = opts.includes("AUCTION");
  const bid = Number(it?.currentBidPrice?.value);
  const fixed = Number(it?.price?.value);
  const price = isAuction && Number.isFinite(bid) ? bid : fixed;
  return {
    itemId: it.itemId || null,
    title: it.title || "",
    price: Number.isFinite(price) ? price : null,
    image: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null,
    url: it.itemWebUrl || null,
    condition: it.condition || null,
    buyingOptions: opts,
    isAuction,
    bidCount: Number.isFinite(Number(it.bidCount)) ? Number(it.bidCount) : null,
  };
}

async function ebaySearch(q, buying, id, secret) {
  const token = await getEbayToken(id, secret);
  const resp = await fetch(
    "https://api.ebay.com/buy/browse/v1/item_summary/search?limit=20&q=" +
      encodeURIComponent(q) + buyingFilter(buying),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    }
  );
  if (!resp.ok) return [];
  const items = (await resp.json()).itemSummaries || [];
  return items
    .map(shapeEbayItem)
    .filter((r) => r.title && r.price && r.image && r.url && r.itemId)
    .slice(0, 12);
}

// Full listing detail (all photos, description, condition, buying format) for
// the wishlist item page. Fetched live so we don't cache eBay listing content.
async function ebayItem(itemId, id, secret) {
  const token = await getEbayToken(id, secret);
  const resp = await fetch(
    "https://api.ebay.com/buy/browse/v1/item/" + encodeURIComponent(itemId),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    }
  );
  if (!resp.ok) return null;
  const it = await resp.json();
  const opts = it.buyingOptions || [];
  const isAuction = opts.includes("AUCTION");
  const bid = Number(it?.currentBidPrice?.value);
  const fixed = Number(it?.price?.value);
  const images = [
    it.image?.imageUrl,
    ...(it.additionalImages || []).map((i) => i.imageUrl),
  ].filter(Boolean);
  // shortDescription is plain text; description is full HTML — strip tags for a
  // clean, themed read and cap length.
  let desc = it.shortDescription || "";
  if (!desc && it.description) {
    desc = it.description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  return {
    itemId: it.itemId || itemId,
    title: it.title || "",
    price: isAuction && Number.isFinite(bid) ? bid : Number.isFinite(fixed) ? fixed : null,
    images,
    description: desc.slice(0, 2000),
    condition: it.condition || null,
    conditionDescription: it.conditionDescription || null,
    buyingOptions: opts,
    isAuction,
    bidCount: Number.isFinite(Number(it.bidCount)) ? Number(it.bidCount) : null,
    url: it.itemWebUrl || null,
    seller: it.seller?.username || null,
    itemLocation:
      [it.itemLocation?.city, it.itemLocation?.stateOrProvince, it.itemLocation?.country]
        .filter(Boolean)
        .join(", ") || null,
  };
}

/* ---------------- Router ---------------- */

export default async (req) => {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const type = (url.searchParams.get("type") || "").toLowerCase();

  const discogsToken = process.env.DISCOGS_TOKEN;
  const reverbToken = process.env.REVERB_TOKEN;
  const ebayId = process.env.EBAY_CLIENT_ID;
  const ebaySecret = process.env.EBAY_CLIENT_SECRET;
  const serpKey = process.env.SERPAPI_KEY;
  const jsonHeaders = { "Content-Type": "application/json" };

  // Wishlist item detail: full listing (all photos, description, format).
  const itemId = url.searchParams.get("item");
  if (itemId) {
    if (!ebayId || !ebaySecret) {
      return new Response(JSON.stringify({ item: null }), { headers: jsonHeaders });
    }
    try {
      const item = await ebayItem(itemId.slice(0, 120), ebayId, ebaySecret);
      return new Response(JSON.stringify({ item }), { headers: jsonHeaders });
    } catch {
      return new Response(JSON.stringify({ item: null }), { headers: jsonHeaders });
    }
  }

  // Wishlist search mode: return a list of eBay items to choose from.
  if (url.searchParams.get("search")) {
    if (!q) return new Response(JSON.stringify({ results: [] }), { headers: jsonHeaders });
    if (!ebayId || !ebaySecret) {
      return new Response(JSON.stringify({ results: [] }), { headers: jsonHeaders });
    }
    const buying = (url.searchParams.get("buying") || "").toLowerCase();
    try {
      const results = await ebaySearch(q, buying, ebayId, ebaySecret);
      return new Response(JSON.stringify({ results }), { headers: jsonHeaders });
    } catch {
      return new Response(JSON.stringify({ results: [] }), { headers: jsonHeaders });
    }
  }

  if (!q) {
    return new Response(JSON.stringify({ error: "missing q" }), { status: 400 });
  }

  // Product image lookup — never allowed to break pricing.
  let productImg = null;
  if (serpKey) {
    try {
      productImg = await serpApiImage(q, serpKey);
    } catch {}
  }

  if (url.searchParams.get("imageonly")) {
    return new Response(JSON.stringify({ image: productImg }), {
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
    if (productImg) {
      return new Response(JSON.stringify({ value: null, image: productImg }), {
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
          result.image = productImg || result.image || firstImage;
          return new Response(JSON.stringify(result), {
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    } catch {}
  }

  return new Response(JSON.stringify({ value: null, image: productImg || firstImage }), {
    headers: { "Content-Type": "application/json" },
  });
};
