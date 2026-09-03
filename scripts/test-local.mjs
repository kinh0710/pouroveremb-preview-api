// Quick local check that your Gemini key + model can render an embroidery preview.
//
// Usage:
//   GEMINI_API_KEY=xxxx node scripts/test-local.mjs \
//     "https://.../blank-back-of-sweatshirt.png" "EMILY" "24" "Royal Blue"
//
// Writes the result to out-preview.png in this folder.

import { writeFileSync } from 'node:fs';

const [, , baseImageUrl, name = 'EMILY', number = '24', color = 'Royal Blue'] = process.argv;
const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-image';

if (!key) { console.error('Set GEMINI_API_KEY in your environment first.'); process.exit(1); }
if (!baseImageUrl) { console.error('Pass a base image URL as the first argument.'); process.exit(1); }

const prompt = [
  `Edit this photo of a ${color} crewneck sweatshirt.`,
  `Add custom EMBROIDERY on the back in a classic American varsity / sports-jersey style:`,
  `- the name "${name}" arched across the upper back,`,
  `- a large jersey number "${number}" centered below the name.`,
  `Use bold block lettering in white with a colored outline matching the team colors.`,
  `Make it look like real stitched embroidery that follows the fabric folds and lighting.`,
  `Keep the garment, color and background EXACTLY the same — only add the embroidery.`,
  `Render the text EXACTLY as written: correct spelling, no extra characters.`,
].join('\n');

console.log(`Model: ${model}`);
console.log(`Fetching base image: ${baseImageUrl}`);
const imgResp = await fetch(baseImageUrl);
if (!imgResp.ok) { console.error(`Base image fetch failed: ${imgResp.status}`); process.exit(1); }
const mime = imgResp.headers.get('content-type') || 'image/png';
const data = Buffer.from(await imgResp.arrayBuffer()).toString('base64');

console.log('Calling Gemini…');
const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
  body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data } }, { text: prompt }] }],
  }),
});
const json = await resp.json().catch(() => ({}));
if (!resp.ok) { console.error('Gemini error:', JSON.stringify(json, null, 2).slice(0, 800)); process.exit(1); }

const parts = json?.candidates?.[0]?.content?.parts || [];
const imgPart = parts.find((p) => (p.inline_data || p.inlineData)?.data);
const out = imgPart && (imgPart.inline_data || imgPart.inlineData);
if (!out) { console.error('No image returned. Full response:', JSON.stringify(json, null, 2).slice(0, 800)); process.exit(1); }

writeFileSync('out-preview.png', Buffer.from(out.data, 'base64'));
console.log('✓ Saved out-preview.png — open it to check the embroidery preview.');
