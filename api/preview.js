// POST /api/preview
// Body JSON: { name, number, color, productTitle, baseImageUrl, model? }
//   model  - optional, allow-listed override to force one model (for testing)
// Returns:   { ok:true, image:"data:image/png;base64,...", modelUsed, promptUsed }
//            { ok:false, error:"..." }
// On a 503/429 (overload / rate-limit) the primary model falls back to the
// GEMINI_FALLBACK_MODELS in order, so the preview keeps working when Pro is busy.
//
// Takes the real lifestyle photo (baseImageUrl — the image set for the chosen
// variant) and asks Google Gemini's image model to swap ONLY the embroidered
// NAME/NUMBER on the back-facing sweatshirt, keeping the rest of the photo
// (both models, faces, front design, background) identical.
// Synchronous: the request waits for Gemini and returns the image inline as a
// data URL (no storage/queue needed — simplest thing that deploys on Vercel).
// baseImageUrl may be an http(s) URL or an inline data:image/...;base64 URL.

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

function buildPrompt({ name, number }) {
  // The base image is the real lifestyle photo (e.g. two models, one seen from
  // the back). We only swap the personalized NAME / NUMBER already embroidered
  // on the back — everything else in the photo stays identical.
  const changes = [];
  if (name) changes.push(`change the arched NAME to read exactly "${name}"`);
  if (number) changes.push(`change the large jersey NUMBER to read exactly "${number}"`);
  return [
    `This is a real photo of people wearing sweatshirts. One person is shown from the BACK, and the back of that sweatshirt already has an embroidered arched NAME above a large jersey NUMBER.`,
    `Edit ONLY that personalized text: ${changes.join(' and ')}.`,
    `Reproduce the EXACT same embroidery already in the photo for the new text — identical block lettering style, white twill fill with the same colored stitched outline, the same pinstripe/fabric texture, raised sewn-on look, the same size, position, arch curvature, perspective, fabric folds and lighting. The replacement must look physically embroidered exactly like the original, just with different characters.`,
    `Do NOT change anything else in the image. Keep BOTH people, their faces, hair, skin, hands and poses; keep the other person's front "Florida" script and gator logo; keep the stadium crowd, seats, field, colors, framing, grain and lighting all pixel-for-pixel identical.`,
    `Return the FULL original photo with only the name/number swapped — do not crop, zoom in, change the composition, or output a separate garment-only image.`,
    `Spell the new text EXACTLY as written above: correct characters only, no extra or missing letters. Render the name in the same ALL-CAPS block style as the original, but PRESERVE the spaces between words exactly — if the name contains a space, keep two separate words with a clear gap (e.g. "DAT BEO", never "DATBEO").`,
  ].join('\n');
}

async function fetchBaseImage(url) {
  // Accept an inline data: URL (base64) as well as a normal http(s) URL.
  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) throw new Error('Malformed data URL');
    const mime = m[1] || 'image/png';
    const data = m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3])).toString('base64');
    return { mime, data };
  }
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
    if (!/^(https?:\/\/|data:image\/)/i.test(baseImageUrl)) return res.status(400).json({ ok: false, error: 'A valid baseImageUrl is required.' });

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
