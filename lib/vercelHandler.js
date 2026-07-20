// Adapts a web-standard handler — (Request) => Response, which is how our
// Netlify functions are written — to Vercel's Node (req, res) signature.
// This lets the exact same function code in netlify/functions/ run on both
// hosts. Netlify calls those functions directly; Vercel calls them through
// this bridge (see api/*.js).

export function toVercel(webHandler) {
  return async function (req, res) {
    try {
      const host = req.headers?.host || "localhost";
      const proto = req.headers?.["x-forwarded-proto"] || "https";
      const url = `${proto}://${host}${req.url}`;

      let body;
      const method = (req.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        if (typeof req.body === "string") {
          body = req.body;
        } else if (req.body && Object.keys(req.body).length > 0) {
          body = JSON.stringify(req.body);
        } else {
          body = await readRawBody(req);
        }
      }

      const request = new Request(url, {
        method,
        headers: req.headers,
        body,
      });

      const response = await webHandler(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(await response.text());
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Function bridge error: " + String(err).slice(0, 200) }));
    }
  };
}

function readRawBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data || undefined));
    req.on("error", () => resolve(undefined));
  });
}
