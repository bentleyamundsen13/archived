// GET /api/showcase?id={collectionId}
// Returns a collection's public, read-only data for the shareable showcase page.
// Only serves collections explicitly flagged public. Reads with the service
// account, so no client access or security-rule changes are needed.

import { getDocRest, listDocsRest } from "../../lib/firestoreRest.js";

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
  });

export default async (req) => {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return json({ error: "missing id" }, 400);
  try {
    const col = await getDocRest(`collections/${id}`);
    if (!col || !col.public) return json({ error: "This showcase isn't public." }, 404);

    const items = await listDocsRest(`collections/${id}/items`);
    const owned = items.filter((it) => !it.wanted);
    // Deliberately NO prices/values — a public showcase shouldn't broadcast
    // the collection's worth. Just the gallery (biggest-first by value).
    return json({
      name: col.name || "Collection",
      type: col.type || "",
      ownerName: col.showcaseOwner || null,
      itemCount: owned.length,
      items: owned
        .sort((a, b) => (b.estimated_value_usd || 0) - (a.estimated_value_usd || 0))
        .map((it) => ({
          item_name: it.item_name || "Item",
          brand: it.brand || "",
          release_year: it.release_year || null,
          image_url: it.image_url || null,
        })),
    });
  } catch (e) {
    return json({ error: e?.message || String(e) }, 500);
  }
};
