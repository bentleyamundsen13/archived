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
    models: [
      "gemini-3-flash",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-flash-latest",
      "gemini-flash-lite-latest",
    ],
  },
  {
    name: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    keyEnv: "GROQ_API_KEY",
    thinking: false,
    models: [
      "meta-llama/llama-4-scout-17b-16e-instruct",
      "meta-llama/llama-4-maverick-17b-128e-instruct",
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

  return fetch(provider.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
}

// Pull the first {...} object out of text that may have extra words around it.
function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON found in model response");
  }
  return JSON.parse(text.slice(start, end + 1));
}

export default async (req) => {
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
    `the user's "${String(category || "general").slice(0, 60)}" collection. ` +
    `Identify exactly what the item is, who made it, and its key specifics.`;

  try {
    let resp = null;
    outer: for (const provider of PROVIDERS) {
      const key = process.env[provider.keyEnv];
      if (!key) continue;
      for (const model of provider.models) {
        // Attempt: strict JSON mode
        resp = await callModel(provider, key, model, prompt, mime || "image/jpeg", imageBase64, true);

        // Per-minute rate limit: wait a moment and retry the same model once
        if (resp.status === 429) {
          await new Promise((r) => setTimeout(r, 3000));
          resp = await callModel(provider, key, model, prompt, mime || "image/jpeg", imageBase64, true);
        }

        // Still limited? That quota is spent — the NEXT model has its own.
        if (resp.status === 429) continue;

        // JSON-mode rejection: retry without it and dig the JSON out ourselves
        if (!resp.ok && resp.status === 400) {
          resp = await callModel(provider, key, model, prompt, mime || "image/jpeg", imageBase64, false);
        }

        // Model retired or unknown: fall through to the next model in the list
        if (resp.status === 404) continue;
        break outer;
      }
    }

    if (!resp || !resp.ok) {
      let detail = "";
      try {
        const errJson = await resp.json();
        detail = errJson?.error?.message || JSON.stringify(errJson).slice(0, 300);
      } catch {
        try {
          detail = (await resp.text()).slice(0, 300);
        } catch {}
      }
      const status = resp ? resp.status : "?";
      const hint =
        resp && resp.status === 429
          ? " All free AI quotas are used up for now — try again in a few minutes."
          : "";
      return new Response(
        JSON.stringify({ error: `AI error ${status}: ${detail}${hint}` }),
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
