// POST /api/feedback  { message, email, page }
// Stores tester feedback in Firestore (via the service account) so it can be
// read in the Firebase console. Works for guests and signed-in users alike.

import { setDocRest } from "../../lib/firestoreRest.js";

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

const FEEDBACK_TO = "archivedapp11@gmail.com";

// Email the feedback via Resend (best-effort — feedback is still saved even if
// email isn't configured or fails). Uses Resend's onboarding sender, which can
// deliver to the address that owns the Resend account (FEEDBACK_TO) with no
// domain verification.
async function emailFeedback({ message, email, page }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Archived Feedback <onboarding@resend.dev>",
        to: [FEEDBACK_TO],
        ...(email ? { reply_to: email } : {}),
        subject: "New Archived feedback",
        text: `${message}\n\n— from: ${email || "guest"}\npage: ${page || "?"}`,
      }),
    });
  } catch {}
}

export default async (req) => {
  try {
    const { message, email, page } = await req.json();
    if (!message || !String(message).trim()) return json({ error: "Empty message" }, 400);
    const clean = {
      message: String(message).slice(0, 2000),
      email: email ? String(email).slice(0, 200) : null,
      page: page ? String(page).slice(0, 120) : null,
      created: Date.now(),
    };
    const id = globalThis.crypto?.randomUUID?.() || String(Date.now() + Math.random());
    // Save to Firestore (durable) and email a copy (best-effort).
    await setDocRest(`feedback/${id}`, clean);
    await emailFeedback(clean);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e?.message || String(e) }, 400);
  }
};
