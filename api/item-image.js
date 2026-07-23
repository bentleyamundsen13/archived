// GET /api/item-image?c={cid}&i={itemId}&p={photoId}
// Serves an item photo (stored base64 in Firestore) as real image bytes so
// eBay can pull it into a listing. Native Vercel handler (binary-safe).

import { getDocRest } from "../lib/firestoreRest.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  const { c, i, p } = req.query || {};
  if (!c || !i || !p) {
    res.status(400).end("bad request");
    return;
  }
  try {
    const path =
      p === "legacy"
        ? `collections/${c}/images/${i}`
        : `collections/${c}/items/${i}/photos/${p}`;
    const doc = await getDocRest(path);
    const dataUrl = doc.data;
    if (typeof dataUrl !== "string") {
      res.status(404).end("not found");
      return;
    }
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
    if (!m) {
      res.status(400).end("bad image");
      return;
    }
    res.setHeader("Content-Type", m[1]);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).send(Buffer.from(m[2], "base64"));
  } catch {
    res.status(500).end("error");
  }
}
