// Server-side Firebase access for the serverless functions. Uses the service
// account in FIREBASE_SERVICE_ACCOUNT (set in Vercel env) so functions can
// verify a user's ID token and store their eBay connection in Firestore.
// The Admin SDK bypasses security rules, so the eBay refresh token lives in a
// collection (ebayTokens) that client rules never expose.

import admin from "firebase-admin";

let ready = false;
function ensure() {
  if (ready) return;
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  ready = true;
}

export function adminAuth() {
  ensure();
  return admin.auth();
}

export function adminDb() {
  ensure();
  return admin.firestore();
}
