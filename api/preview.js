// POST /api/preview
// Body JSON: { name, number, color, productTitle, baseImageUrl, model? }
//   model  - optional, allow-listed override to force one model (for testing)
// Returns:   { ok:true, image:"data:image/png;base64,...", modelUsed, promptUsed }
//            { ok:false, error:"..." }
// On a 503/429 (overload / rate-limit) the primary model falls back to the
// GEMINI_FALLBACK_MODELS in order, so the preview keeps working when Pro is busy.
//
// Takes the base garment photo + the customer's NAME/NUMBER and asks Google
// Gemini's image model to render an AI preview with the embroidery applied.
// Synchronous: the request waits for Gemini and returns the image inline as a
// data URL (no storage/queue needed — simplest thing that deploys on Vercel).

// Gemini IMAGE model ("Nano Banana" family). Override via env GEMINI_MODEL.
// Default: Nano Banana Pro (Gemini 3 Pro Image) — best-in-class text rendering,
// which matters for getting NAME/NUMBER spelled correctly.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-pro-image-preview';

// If the primary model is overloaded (503) or rate-limited (429), fall through
// to these in order. Keeps the preview working when Pro is busy.
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS ||
  'gemini-3.1-flash-image,gemini-2.5-flash-image')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Model ids a request may explicitly ask for (via body.model), for testing.
const ALLOWED_MODELS = new Set([
  GEMINI_MODEL,
  ...GEMINI_FALLBACK_MODELS,
  'gemini-3-pro-image-preview',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite-image',
  'gemini-2.5-flash-image',
]);

// Comma-separated list of storefront origins allowed to call this API.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://pouroveremb.com,https://www.pouroveremb.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Let a long Gemini call finish (Vercel: 60s on Hobby, up to 300s on Pro).
export const config = { maxDuration: 60 };

function setCors(res, origin) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowed || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function buildPrompt({ name, number, color, productTitle }) {
  const garment = `${color ? color + ' ' : ''}crewneck sweatshirt${productTitle ? ` (${productTitle})` : ''}`;
  return [
    `Edit this photo of a ${garment}.`,
    `Add custom EMBROIDERY on the back in a classic American varsity / sports-jersey style:`,
    name ? `- the name "${name}" arched across the upper back,` : '',
    number ? `- a large jersey number "${number}" centered below the name.` : '',
    `Use bold block lettering in white with a colored outline that matches the garment's team colors.`,
    `Make it look like real stitched embroidery / twill appliqué that follows the fabric folds, wrinkles and lighting.`,
    `Keep the garment shape, color, background and everything else in the photo EXACTLY the same — only add the embroidery.`,
    `Render the text EXACTLY as written above: correct spelling, no extra or missing characters, no random letters.`,
  ].filter(Boolean).join('\n');
}

async function fetchBaseImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Cannot fetch base image (${r.status})`);
  const mime = r.headers.get('content-type') || 'image/png';
  const data = Buffer.from(await r.arrayBuffer()).toString('base64');
  return { mime, data };
}

function extractImage(gJson) {
  const parts = gJson?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const inline = p.inline_data || p.inlineData;
    if (inline?.data) {
      const mime = inline.mime_type || inline.mimeType || 'image/png';
      return { mime, data: inline.data };
    }
  }
  return null;
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ ok: false, error: 'Server is missing GEMINI_API_KEY' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const name = String(body.name || '').trim().slice(0, 20);
    const number = String(body.number || '').trim().slice(0, 4);
    const color = String(body.color || '').trim().slice(0, 40);
    const productTitle = String(body.productTitle || '').trim().slice(0, 120);
    const baseImageUrl = String(body.baseImageUrl || '').trim();

    if (!name && !number) return res.status(400).json({ ok: false, error: 'Enter a name or a number first.' });
    if (!/^https?:\/\//i.test(baseImageUrl)) return res.status(400).json({ ok: false, error: 'A valid baseImageUrl is required.' });

    const base = await fetchBaseImage(baseImageUrl);
    const prompt = buildPrompt({ name, number, color, productTitle });
    const payload = {
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: base.mime, data: base.data } },
          { text: prompt },
        ],
      }],
    };

    // Which models to try, in order. An explicit (allow-listed) body.model wins.
    const requested = typeof body.model === 'string' && ALLOWED_MODELS.has(body.model) ? body.model : null;
    const models = requested ? [requested] : [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];

    let lastErr = '';
    for (const model of models) {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const gResp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(payload),
      });
      const gJson = await gResp.json().catch(() => ({}));

      if (gResp.ok) {
        const img = extractImage(gJson);
        if (img) {
          return res.status(200).json({ ok: true, image: `data:${img.mime};base64,${img.data}`, modelUsed: model, promptUsed: prompt });
        }
        const finish = gJson?.candidates?.[0]?.finishReason || 'unknown';
        lastErr = `Model ${model} returned no image (finishReason: ${finish}).`;
        continue; // try next model
      }

      const msg = gJson?.error?.message || JSON.stringify(gJson).slice(0, 200);
      lastErr = `Gemini API error (${gResp.status}) on ${model}: ${msg}`;
      // Only fall through on transient overload / rate-limit; otherwise stop.
      const transient = gResp.status === 503 || gResp.status === 429 || /overload|high demand|unavailable|exhaust/i.test(msg);
      if (!transient) break;
    }

    throw new Error(lastErr || 'All image models failed');
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
