// Vercel Function: /api/ebay-connect
import handler from "../netlify/functions/ebay-connect.js";
import { toVercel } from "../lib/vercelHandler.js";

// firebase-admin cold start + verifyIdToken can be slow; give it headroom.
export const config = { maxDuration: 30 };

export default toVercel(handler);
