// GET /api/price-history?q=search+terms
// Queries eBay completed/sold listings in six 2-week windows going back 12 weeks
// (within eBay's 90-day completed-items limit). Returns [{t, v}] price points
// for immediate graph backfill so users don't have to wait for daily refreshes.

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

async function ebayWindowPrice(q, fromDate, toDate, appId) {
  const params = new URLSearchParams({
    "OPERATION-NAME": "findCompletedItems",
    "SERVICE-VERSION": "1.0.0",
    "SECURITY-APPNAME": appId,
    "RESPONSE-DATA-FORMAT": "JSON",
    keywords: q,
    "itemFilter(0).name": "SoldItemsOnly",
    "itemFilter(0).value": "true",
    "itemFilter(1).name": "EndTimeFrom",
    "itemFilter(1).value": fromDate.toISOString(),
    "itemFilter(2).name": "EndTimeTo",
    "itemFilter(2).value": toDate.toISOString(),
    sortOrder: "EndTimeSoonest",
    "paginationInput.entriesPerPage": "50",
  });

  const resp = await fetch(
    "https://svcs.ebay.com/services/search/FindingService/v1?" + params
  );
  if (!resp.ok) return null;

  const data = await resp.json();
  const items =
    data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];

  let prices = items
    .filter((it) => it?.sellingStatus?.[0]?.sellingState?.[0] === "EndedWithSales")
    .map((it) => Number(it?.sellingStatus?.[0]?.currentPrice?.[0]?.__value__))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  if (prices.length < 3) return null;
  prices = trimOutliers(prices);
  return Math.round(median(prices));
}

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default async (req) => {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  if (!q) return json({ history: [] });

  const appId = process.env.EBAY_CLIENT_ID;
  if (!appId) return json({ history: [] });

  const now = Date.now();
  const WINDOW = 14 * 864e5; // 2-week buckets

  // Six windows covering the past 12 weeks (84 days, within eBay's 90-day limit).
  const windows = Array.from({ length: 6 }, (_, i) => {
    const toMs = now - i * WINDOW;
    const fromMs = toMs - WINDOW;
    return { fromDate: new Date(fromMs), toDate: new Date(toMs), midMs: Math.round((fromMs + toMs) / 2) };
  });

  const results = await Promise.all(
    windows.map(async ({ fromDate, toDate, midMs }) => {
      try {
        const v = await ebayWindowPrice(q, fromDate, toDate, appId);
        return v !== null ? { t: midMs, v } : null;
      } catch {
        return null;
      }
    })
  );

  const history = results.filter(Boolean).sort((a, b) => a.t - b.t);
  return json({ history });
};
