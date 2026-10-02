# Deploying ONECLICK (free tier)

Frontend on Vercel, Launch API on Render. Both are connected to one GitHub repo that contains this whole folder.

## What goes live
- Site: the single HTML file, built to `public/index.html` by `scripts/build-site.js`.
- API: `launch/` (zero dependencies). It analyzes public GitHub repos. It does NOT install, build or run them.

## 1. Push to GitHub
```
cd D:\ONECLICK
git init
git add .
git commit -m "ONECLICK Launch: site + analysis API"
git branch -M main
git remote add origin https://github.com/<you>/oneclick.git
git push -u origin main
```
(`backup/` will be pushed too. Add `backup/` to `.gitignore` first if you don't want that.)

## 2. GitHub token (do this first)
Render's free instances share outbound IPs, so unauthenticated GitHub calls (60/hour per IP) run out fast.
GitHub > Settings > Developer settings > Fine-grained tokens > Generate. Public repositories only, no permissions needed. Copy it.

## 3. Render (API)
1. Render dashboard > New > Blueprint > pick the repo. It reads `render.yaml`.
2. When asked for `GITHUB_TOKEN`, paste the token.
3. After deploy, open `https://<service>.onrender.com/api/health`. You should see `{"ok":true,...}`.
4. Note the exact URL. If `oneclick-launch` was taken, Render adds a suffix.

Free-tier behavior: the service sleeps after about 15 minutes idle, and the first request after that takes up to a minute. The page pre-warms it on load and tells the visitor while it wakes.

## 4. Point the site at the API
In `OneClick — Software, simplified.html`, set the production URL in `API_BASE` to the Render URL from step 3. Commit and push.

## 5. Vercel (site)
1. Vercel > Add New > Project > import the same repo.
2. Framework preset: Other. Root directory: repo root. `vercel.json` supplies the build command and output directory.
3. Deploy. Every push to `main` redeploys.

## 6. Optional hardening
Render > Environment: set `CORS_ORIGIN` to your Vercel URL (e.g. `https://oneclick.vercel.app`) so only your site can call the API from a browser.

## Local run
```
cd launch
npm start          # API on http://127.0.0.1:8787
npm test
```
Open the HTML file directly; it talks to the local API automatically.
