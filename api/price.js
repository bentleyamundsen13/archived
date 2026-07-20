// Vercel Function: /api/price
// Runs the shared Netlify function through a Node<->web bridge so one
// codebase serves both hosts.
import priceHandler from "../netlify/functions/price.js";
import { toVercel } from "../lib/vercelHandler.js";

export default toVercel(priceHandler);
