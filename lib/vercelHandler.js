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
        // Vercel usually pre-parses the body into req.body; cover every shape
        // it might arrive in, and fall back to reading the raw stream.
        if (Buffer.isBuffer(req.body)) {
          body = req.body.toString("utf8");
        } else if (typeof req.body === "string") {
          body = req.body;
        } else if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
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
    // If the stream is already drained (e.g. a parser consumed it), don't
    // wait for events that will never fire.
    if (req.readableEnded) {
      resolve(undefined);
      return;
    }
    let data = "";
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => finish(data || undefined));
    req.on("error", () => finish(undefined));
    // Safety net: never hang the function on a stalled/consumed stream.
    setTimeout(() => finish(data || undefined), 5000);
  });
}
