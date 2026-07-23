// Vercel Function: /api/ebay-callback
import handler from "../netlify/functions/ebay-callback.js";
import { toVercel } from "../lib/vercelHandler.js";

export default toVercel(handler);
