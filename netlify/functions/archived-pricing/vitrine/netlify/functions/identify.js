// Netlify Function: /.netlify/functions/identify
// Runs on Netlify's servers — GEMINI_API_KEY lives here, never in the browser.

const VISION_MODEL = "gemini-flash-latest";

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

async function callGroq(key, prompt, mime, imageBase64, useJsonMode) {
  const body = {
    model: VISION_MODEL,
    temperature: 0.2,
    max_tokens: 1024,
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
  if (useJsonMode) body.response_format = { type: "json_object" };

  return fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
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

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return new Response(
      JSON.stringify({ error: "GEMINI_API_KEY is not set on the server." }),
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
    // Attempt 1: strict JSON mode
    let resp = await callGroq(key, prompt, mime || "image/jpeg", imageBase64, true);

    // If JSON mode failed (Groq 400s when the model's output isn't valid
    // JSON), retry once without it and dig the JSON out ourselves.
    if (!resp.ok && resp.status === 400) {
      resp = await callGroq(key, prompt, mime || "image/jpeg", imageBase64, false);
    }

    if (!resp.ok) {
      let detail = "";
      try {
        const errJson = await resp.json();
        detail = errJson?.error?.message || JSON.stringify(errJson).slice(0, 300);
      } catch {
        detail = (await resp.text()).slice(0, 300);
      }
      return new Response(
        JSON.stringify({ error: `Gemini error ${resp.status}: ${detail}` }),
        { status: 502 }
      );
    }

    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content || "";
    const item = extractJson(raw);

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
