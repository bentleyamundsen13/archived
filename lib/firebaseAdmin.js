// Server-side Firebase access for the serverless functions. Uses the service
// account in FIREBASE_SERVICE_ACCOUNT (set in Vercel env) so functions can
// verify a user's ID token and store their eBay connection in Firestore.
// The Admin SDK bypasses security rules, so the eBay refresh token lives in a
// collection (ebayTokens) that client rules never expose.
//
// Uses firebase-admin's modular (ESM) entry points — the default
// `import admin from "firebase-admin"` doesn't expose `.apps` under ESM.

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

let ready = false;
function ensure() {
  if (ready) return;
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  ready = true;
}

export function adminAuth() {
  ensure();
  return getAuth();
}

export function adminDb() {
  ensure();
  return getFirestore();
}
