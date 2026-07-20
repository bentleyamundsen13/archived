// Vercel Function: /api/price
// Same code as the Netlify function — this file just re-exports it so the
// app runs identically on either host.
export { default } from "../netlify/functions/price.js";
