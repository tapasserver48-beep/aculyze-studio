# Render Deployment Guide for Zara AI / Aculyze Studio

## ✅ Can deploy to Render

**Yes, this app CAN be deployed to Render**, but with some considerations:

### Prerequisites

1. **NVIDIA API Key** (required for AI functionality)
   - Get one from https://build.nvidia.com/
   - Your current key starts with `nvapi-4pjOVOL7CR9r...`

2. **Optional: LM Studio API Key** (backup/fallback)
   - Kept for hybrid mode failover

3. **Search Provider** (optional but recommended)
   - Use `SEARCH_PROVIDER=duckduckgo` (keyless, works everywhere)
   - Or `SEARCH_PROVIDER=google` with `GOOGLE_SEARCH_KEY` env var

4. **Aculyze LMS API Key** (optional)
   - Your key starts with `ak_live_...`

### Environment Variables to Set in Render

```
# Required for AI (your current key)
NVIDIA_API_KEY=nvapi-4pjOVOL7CR9r...

# Search (use duckduckgo for Render - it's keyless)
SEARCH_PROVIDER=duckduckgo

# Optional: LMS
LMS_API_KEY=ak_live_...
LMS_API_URL=https://api.aculyze.com

# AI Provider (hybrid = NVIDIA primary, LM Studio fallback)
AI_PROVIDER=hybrid
LM_STUDIO_URL= # leave empty - will be ignored if not set

# Mode
MODE=aculyze-studio  # Production mode
```

### Render Settings

**Build Command:** `npm install`

**Start Command:** `npm start`

**Node Version:** 18+ (specified in package.json)

### Important Notes

1. **Playwright** - Uses DuckDuckGo by default which works without browser binaries
   - If you enable Google Search, get a Custom Search API key

2. **LM Studio** - LOCAL ONLY, disabled on Render
   - Your config is preserved as fallback when running locally
   - On Render, NVIDIA is primary

3. **Gmail/Google OAuth** - Currently UNCONFIGURED (deferred per requirements)
   - No Google client ID/secret set
   - Gmail tools will show "not connected" to users

4. **Media Files** - All videos/images are in public/ folder
   - The app expects `/flighton.mp4` as background video
   - No special handling needed

### Files Ready for Deployment

✅ `package.json` - Dependencies defined
✅ `server.js` - Entry point
✅ `src/**/*.js` - All source code
✅ `public/**` - Frontend assets
✅ `.gitignore` - Excludes node_modules, data, env

### Files NOT Needed (excluded by .gitignore)

❌ `node_modules/` - Installed during build
❌ `data/` - User-specific data (created at runtime)
❌ `.env` - Real secrets not in repo
❌ Large video files (`*.mp4`) - Can be kept but large
❌ Debug/logs - Generated at runtime

### Alternative: Docker Deployment

If you prefer Docker, create a `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

Then add `Dockerfile` to the repo and deploy via Render's Docker service.