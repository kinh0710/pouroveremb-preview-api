# pouroveremb — AI embroidery preview API

Tiny Vercel serverless backend that powers the **"Preview with AI"** button on
pouroveremb.com. It takes a blank garment photo + the customer's NAME/NUMBER and
asks Google Gemini's image model to render an embroidery mockup.

```
Browser (theme block)  ──POST /api/preview──▶  Vercel function  ──▶  Gemini image model
        ◀──────────────  { image: dataURL }  ──────────────────────┘
```

## 1. Get a Gemini API key
1. Go to <https://aistudio.google.com/apikey> and create an API key.
2. Image generation is a **paid** feature — enable billing on the Google Cloud
   project behind the key. You pay per generated image.

## 2. Deploy to Vercel
```bash
npm i -g vercel        # if you don't have it
cd pouroveremb-preview-api
vercel                 # first run: link/create the project (accept defaults)
```
Then add environment variables (Vercel dashboard → Project → Settings →
Environment Variables), or via CLI:
```bash
vercel env add GEMINI_API_KEY       # paste your key
vercel env add ALLOWED_ORIGINS      # https://pouroveremb.com,https://www.pouroveremb.com
# optional: vercel env add GEMINI_MODEL   # gemini-2.5-flash-image
vercel --prod          # deploy to production
```
Your endpoint will be: `https://<your-project>.vercel.app/api/preview`

## 3. Wire it into the theme
In the Shopify theme editor, open the product with the **Jersey personalizer**
block and paste that endpoint into **AI preview → Preview API endpoint**.

## Test the key before deploying
```bash
GEMINI_API_KEY=xxxx node scripts/test-local.mjs \
  "https://your-cdn/blank-back-sweatshirt.png" "EMILY" "24" "Royal Blue"
# writes out-preview.png
```

## API
`POST /api/preview`
```json
{ "name": "EMILY", "number": "24", "color": "Royal Blue",
  "productTitle": "Florida Gators Sweatshirt",
  "baseImageUrl": "https://cdn.shopify.com/.../blank-back.png" }
```
→ `{ "ok": true, "image": "data:image/png;base64,..." }`
or `{ "ok": false, "error": "..." }`

## Notes / cost control
- The function returns the image inline (data URL) — no database or file storage
  to set up. Simple and cheap.
- Gemini image models can misspell text occasionally. The garment is embroidered
  from the **typed** Name/Number (line-item properties), not from the preview —
  the preview is illustration only. This is stated on the storefront.
- To cut cost/abuse later: add simple rate limiting or a per-session cache.
