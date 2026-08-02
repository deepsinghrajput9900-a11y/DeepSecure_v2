# DeepSecure v2

Confidential file sharing with server-enforced expiry, view limits, and an
audit log. This version fixes the two real bugs from the first build.

## What changed from v1

| Bug | Root cause | Fix in v2 |
|---|---|---|
| Build failed on Render (`gyp ERR!`) | `better-sqlite3` needs native C++ compilation, which failed on the free build environment | Replaced with a plain JSON file store — zero native dependencies |
| Shared links opened as `localhost` and refused to connect | Server only knew its own address via a manually-set `PUBLIC_BASE_URL` env var, which was left blank | Server now **detects its own public URL automatically** from each request's headers. `PUBLIC_BASE_URL` is optional and only needed to override this |
| "Unauthorized" after editing environment variables | Editing env vars on Render can silently drop existing ones if you're not careful | v2 doesn't fix Render's UI, but the app now shows a clear on-screen banner ("Server setup incomplete: SENDER_API_KEY is not set") instead of a confusing generic error, so it's obvious immediately |
| Sender key had to be re-typed on every page reload | Key was only kept in page memory | Now saved in the browser's local storage, persists across reloads |

## 1. Get the code into a repo

Push/upload this folder to a GitHub repo (same process as before: create repo
→ upload files → commit).

## 2. Deploy (Render, free tier)

1. [render.com](https://render.com) → New → Web Service → connect your repo.
2. Build command: `npm install`
3. Start command: `npm start`
4. Instance type: Free
5. Environment variable: `SENDER_API_KEY` → any random string (generate one
   with the command in `.env.example`).
   **You do NOT need to set `PUBLIC_BASE_URL` this time** — the server
   figures out its own address automatically. This is the fix for the
   `localhost` bug.
6. Deploy. Once live, open the URL Render gives you, paste your
   `SENDER_API_KEY` into the Dashboard, and test end-to-end: upload a file,
   create a link, open that link in a new tab.

If anything's misconfigured, the app now tells you directly on-screen via a
banner instead of a cryptic error — check that first.

## 3. Turn it into an APK (Amazon Appstore or direct install)

This app is a proper installable PWA now (manifest + icons + service
worker were missing in v1 — added here).

1. Go to [pwabuilder.com](https://pwabuilder.com), enter your live Render
   URL, tap Start.
2. It should now score well since the manifest has real icons this time.
3. Generate an **Android package** → download the `.apk`.
4. This produces a **Trusted Web Activity** — a native Android app shell
   that loads your live site. Your Render app still needs to be running
   for it to work; nothing is bundled offline.

### Publishing to the Amazon Appstore

1. Create a free Amazon Developer account at
   [developer.amazon.com](https://developer.amazon.com).
2. In the Appstore Developer Console, choose **"Add a New App"** → Android.
3. Upload the `.apk` you generated from PWABuilder.
4. Fill in the store listing: app name, description, screenshots (take a
   few from your phone), icon (use the 512×512 one from `public/icons/`),
   category, content rating questionnaire.
5. Submit for review. Amazon's review typically takes a few days.

A few things worth knowing before you submit:
- Amazon (like Google) reviews for functionality and policy compliance —
  make sure the deployed app is actually reachable and working when they
  test it, since free-tier hosts can sleep and delay the first load.
- Content rating: since this app lets a user share arbitrary files, the
  content rating questionnaire may ask about user-generated content — answer
  honestly based on what the app actually does (no built-in content
  moderation, since files are private/expiring links, not publicly browsable).
- If you want a more polished submission, consider upgrading off the free
  Render tier first so the app doesn't have a 30–50 second cold-start delay
  during Amazon's review testing.

## 4. Production hardening (if you keep building on this)

- Swap the JSON file store for Postgres if you expect concurrent writers.
- Move uploaded files to S3/Cloudflare R2 for durability beyond a single
  server's disk.
- Add real multi-user auth if more than one person will send files —
  `requireSender()` in `server.js` is a single shared-key placeholder.
