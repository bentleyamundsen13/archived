// Vercel Function: /api/ebay-ready
import handler from "../netlify/functions/ebay-ready.js";
import { toVercel } from "../lib/vercelHandler.js";

export const config = { maxDuration: 30 };

export default toVercel(handler);
