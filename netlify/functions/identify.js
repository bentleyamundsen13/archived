// Netlify Function: /.netlify/functions/identify
// Runs on Netlify's servers — API keys (GEMINI_API_KEY, GROQ_API_KEY) live
// here, never in the browser.

// Every model has its OWN free-tier quota, and Gemini and Groq are separate
// services with separate free tiers — so this list is real extra capacity,
// not just error handling. Unknown model ids return 404 and are skipped.
const PROVIDERS = [
  {
    name: "Gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    keyEnv: "GEMINI_API_KEY",
    thinking: true,
    // Current Gemini Flash line as of Sept 2026. `gemini-flash-latest` is
    // an alias that always points at the newest Flash; keeping it last means
    // the request survives even after Google renames the specific IDs.
    models: [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "gemini-flash-latest",
    ],
  },
  {
    name: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    keyEnv: "GROQ_API_KEY",
    thinking: false,
    models: [
      // Groq deprecated the Llama 4 vision models in June 2026;
      // Qwen 3.6 27B is their current vision-capable multimodal model.
      "qwen/qwen3.6-27b",
    ],
  },
  {
    name: "Mistral",
    url: "https://api.mistral.ai/v1/chat/completions",
    keyEnv: "MISTRAL_API_KEY",
    thinking: false,
    // Pixtral is Mistral's vision line. `-latest` aliases stay current
    // when Mistral versions models; the pinned Pixtral 12B stays as a
    // stable last resort.
    models: [
      "pixtral-large-latest",
      "pixtral-12b-latest",
      "pixtral-12b-2409",
    ],
  },
];

const JSON_RULES =
  "Respond ONLY with a JSON object with exactly these keys: " +
  "brand (string — the maker, artist, or manufacturer), " +
  "item_name (string — the specific item, e.g. album title or model name), " +
  "release_year (integer or null — when it was released or made), " +
  "condition (string — visible condition from the photo), " +
  "estimated_value_usd (number — estimated average resale price in USD from your knowledge), " +
  "value_confidence ('low'|'medium'|'high'), " +
  "notable_details (string — edition, variant, finish, or specifics that matter). " +
  "No markdown, no explanation, no code fences — just the raw JSON object. " +
  "If unsure about anything, give your best guess and set value_confidence to 'low'.";

async function callModel(provider, key, model, prompt, mime, imageBase64, useJsonMode) {
  const body = {
    model,
    temperature: 0.2,
    // Thinking models (Gemini Flash) spend output tokens on internal
    // reasoning first — keep that short but leave room so the JSON answer
    // never gets cut off. Non-thinking models just need the JSON.
    max_tokens: provider.thinking ? 4096 : 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `${prompt}\n\n${JSON_RULES}` },
          {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${imageBase64}` },
          },
        ],
      },
    ],
  };
  if (provider.thinking) body.reasoning_effort = "low";
  if (useJsonMode) body.response_format = { type: "json_object" };

  // Node's global fetch has NO default timeout — a stalled upstream would
  // hang the whole function until the platform kills it. Cap each call so
  // a slow model aborts and we fall through to the next one.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    return await fetch(provider.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Pull a JSON object out of a model response that may include markdown fences,
// leading commentary, or curly braces inside quoted string values. Tries a few
// increasingly-forgiving strategies rather than one brittle greedy match.
function extractJson(text) {
  let candidate = text;
  // Strip markdown code fences (```json ... ``` or bare ``` ... ```). Some
  // models add these even when told not to.
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1];

  // Try #1: whole trimmed candidate as-is.
  const trimmed = candidate.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try { return JSON.parse(trimmed); } catch {}
  }

  // Try #2: bracket-balanced scan from the first '{' that respects string
  // literals — avoids the "curly brace inside a string" failure mode of a
  // naive first/last lookup.
  const start = candidate.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < candidate.length; i++) {
      const c = candidate[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(candidate.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }

  // Try #3: last-ditch — the old first-open to last-close slice.
  const s = candidate.indexOf("{");
  const e = candidate.lastIndexOf("}");
  if (s !== -1 && e > s) {
    try { return JSON.parse(candidate.slice(s, e + 1)); } catch {}
  }

  throw new Error("No parsable JSON in model response");
}

export default async (req) => {
  // Fast health check: /api/identify?diag=1 — confirms the deploy is live
  // and which AI providers have keys configured, without doing any work.
  try {
    const u = new URL(req.url);
    if (req.method === "GET" && u.searchParams.get("diag")) {
      // ?diag=1 — quick health check, just lists configured providers.
      // ?diag=full — probes every model with a tiny text-only request so
      // we can see EXACTLY which models return which error. Never expose
      // this endpoint's output to real users; it will show raw provider
      // errors including model IDs.
      if (u.searchParams.get("diag") === "full") {
        const results = [];
        for (const provider of PROVIDERS) {
          const key = process.env[provider.keyEnv];
          if (!key) {
            results.push({ provider: provider.name, model: null, status: "no_key" });
            continue;
          }
          for (const model of provider.models) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            try {
              const resp = await fetch(provider.url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${key}`,
                },
                body: JSON.stringify({
                  model,
                  messages: [{ role: "user", content: "hi" }],
                  max_tokens: 5,
                }),
                signal: controller.signal,
              });
              let detail = "";
              try {
                const j = await resp.json();
                detail = j?.error?.message || (resp.ok ? "ok" : JSON.stringify(j).slice(0, 200));
              } catch {}
              results.push({
                provider: provider.name,
                model,
                status: resp.status,
                detail: detail.slice(0, 200),
              });
            } catch (err) {
              results.push({
                provider: provider.name,
                model,
                status: "network_error",
                detail: String(err).slice(0, 200),
              });
            } finally {
              clearTimeout(timer);
            }
          }
        }
        return new Response(JSON.stringify({ ok: true, results }, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          version: "bridge2",
          providers: PROVIDERS.filter((p) => process.env[p.keyEnv]).map((p) => p.name),
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
  } catch {}

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }

  if (!PROVIDERS.some((p) => process.env[p.keyEnv])) {
    return new Response(
      JSON.stringify({ error: "No AI API key is set on the server." }),
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad request body" }), { status: 400 });
  }

  const { category, imageBase64, mime } = body;
  if (!imageBase64) {
    return new Response(JSON.stringify({ error: "No image provided" }), { status: 400 });
  }

  const prompt =
    `You are an expert appraiser of collectible items. This photo is from ` +
    `the user's "${String(category || "general").slice(0, 60)}" collection.\n\n` +
    `Look CAREFULLY at:\n` +
    `- Any brand names, logos, or wordmarks printed on the item\n` +
    `- Model numbers, reference numbers, serial numbers, or edition text\n` +
    `- Size, proportions, and distinctive design details\n` +
    `- Color, materials, and finish\n\n` +
    `IMPORTANT: If you cannot confidently identify the exact brand and model, ` +
    `say so with value_confidence: 'low' instead of guessing. Similar-looking items ` +
    `from different brands are common — a Teenage Engineering Pocket Operator is ` +
    `NOT the same as a Korg Volca, a Seiko SKX007 is NOT a Seiko 5, an Air Jordan 1 ` +
    `Retro is NOT an Air Jordan 1 Low. Be specific and accurate. If the exact model ` +
    `is unclear, name the general category (e.g. "Vintage Japanese diver watch, brand ` +
    `unclear") rather than picking a specific model at random.\n\n` +
    `Identify exactly what the item is, who made it, and its key specifics.`;

  try {
    let resp = null;
    outer: for (const provider of PROVIDERS) {
      const key = process.env[provider.keyEnv];
      if (!key) continue;
      for (const model of provider.models) {
        try {
          // Attempt: strict JSON mode
          resp = await callModel(provider, key, model, prompt, mime || "image/jpeg", imageBase64, true);

          // JSON-mode rejection: retry without it and dig the JSON out ourselves
          if (!resp.ok && resp.status === 400) {
            resp = await callModel(provider, key, model, prompt, mime || "image/jpeg", imageBase64, false);
          }
        } catch {
          // Network error or timeout abort — try the next model.
          resp = null;
          continue;
        }

        if (resp.ok) break outer;
        // Anything else — 429 quota spent, 503 model overloaded, 404 model
        // retired — the next model has its own quota and capacity. No
        // sleep-and-retry: Netlify cuts functions off at 10s, and with this
        // many fallbacks, moving on beats waiting.
      }
    }

    if (!resp || !resp.ok) {
      // User-facing message stays generic and helpful. The raw provider
      // error is logged server-side so we can debug without leaking model
      // names, keys, or upstream stack traces to users.
      let debugDetail = "";
      try {
        const errJson = await resp.json();
        debugDetail = errJson?.error?.message || JSON.stringify(errJson).slice(0, 300);
      } catch {
        try {
          debugDetail = (await resp.text()).slice(0, 300);
        } catch {}
      }
      const status = resp ? resp.status : "?";
      console.error(`identify: all AI providers failed (last status ${status}): ${debugDetail}`);
      const userMessage =
        resp && resp.status === 429
          ? "The AI is busy right now. Try again in a couple of minutes."
          : resp && resp.status >= 500
            ? "The AI is having a rough moment. Give it a minute and try again."
            : "Couldn't identify that item right now. Try again in a moment, or enter the details yourself.";
      return new Response(
        JSON.stringify({ error: userMessage }),
        { status: 502 }
      );
    }

    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content || "";
    let item;
    try {
      item = extractJson(raw);
    } catch (e) {
      const finish = data.choices?.[0]?.finish_reason || "?";
      throw new Error(
        `no JSON (finish_reason=${finish}, got: "${raw.slice(0, 80)}")`
      );
    }

    const value = Number(item.estimated_value_usd);
    item.estimated_value_usd = Number.isFinite(value) ? value : 0;
    item.value_is_ai_estimate = true;

    return new Response(JSON.stringify({ item }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Couldn't read the AI's answer — try the photo again. (" + String(err).slice(0, 120) + ")" }),
      { status: 500 }
    );
  }
};
