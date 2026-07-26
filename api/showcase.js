// Vercel Function: /api/showcase
import handler from "../netlify/functions/showcase.js";
import { toVercel } from "../lib/vercelHandler.js";

export const config = { maxDuration: 30 };

export default toVercel(handler);
