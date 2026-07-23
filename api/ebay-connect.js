// Vercel Function: /api/ebay-connect
import handler from "../netlify/functions/ebay-connect.js";
import { toVercel } from "../lib/vercelHandler.js";

export default toVercel(handler);
