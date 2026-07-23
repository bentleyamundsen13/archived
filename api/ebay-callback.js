// Vercel Function: /api/ebay-callback
import handler from "../netlify/functions/ebay-callback.js";
import { toVercel } from "../lib/vercelHandler.js";

// firebase-admin cold start + eBay token exchange can be slow; give it headroom.
export const config = { maxDuration: 30 };

export default toVercel(handler);
