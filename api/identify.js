// Vercel Function: /api/identify
// Same code as the Netlify function — this file just re-exports it so the
// app runs identically on either host. The web-standard handler signature
// (Request in, Response out) works on both.
export { default } from "../netlify/functions/identify.js";
