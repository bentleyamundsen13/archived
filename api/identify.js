// Vercel Function: /api/identify
// Runs the shared Netlify function through a Node<->web bridge so one
// codebase serves both hosts. Allow up to 60s — the AI fallback chain can
// take a few seconds and Vercel's default cap is 10s.
import identifyHandler from "../netlify/functions/identify.js";
import { toVercel } from "../lib/vercelHandler.js";

export const config = { maxDuration: 60 };

export default toVercel(identifyHandler);
