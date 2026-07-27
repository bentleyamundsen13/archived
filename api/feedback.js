// Vercel Function: /api/feedback
import handler from "../netlify/functions/feedback.js";
import { toVercel } from "../lib/vercelHandler.js";

export const config = { maxDuration: 20 };

export default toVercel(handler);
