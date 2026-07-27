// POST /api/feedback  { message, email, page }
// Stores tester feedback in Firestore (via the service account) so it can be
// read in the Firebase console. Works for guests and signed-in users alike.

import { setDocRest } from "../../lib/firestoreRest.js";

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

export default async (req) => {
  try {
    const { message, email, page } = await req.json();
    if (!message || !String(message).trim()) return json({ error: "Empty message" }, 400);
    const id = (globalThis.crypto?.randomUUID?.() || String(Date.now() + Math.random()));
    await setDocRest(`feedback/${id}`, {
      message: String(message).slice(0, 2000),
      email: email ? String(email).slice(0, 200) : null,
      page: page ? String(page).slice(0, 120) : null,
      created: Date.now(),
    });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e?.message || String(e) }, 400);
  }
};
