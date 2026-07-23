// Vercel Function: /api/ebay-list
import handler from "../netlify/functions/ebay-list.js";
import { toVercel } from "../lib/vercelHandler.js";

export const config = { maxDuration: 60 };

export default toVercel(handler);
