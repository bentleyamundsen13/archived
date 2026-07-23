// Vercel Function: /api/ebay-prep
import handler from "../netlify/functions/ebay-prep.js";
import { toVercel } from "../lib/vercelHandler.js";

export const config = { maxDuration: 30 };

export default toVercel(handler);
