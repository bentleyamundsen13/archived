// Vercel Function: /api/price-history
import handler from "../netlify/functions/price-history.js";
import { toVercel } from "../lib/vercelHandler.js";

export const config = { maxDuration: 30 };

export default toVercel(handler);
