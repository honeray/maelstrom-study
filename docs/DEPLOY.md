# Deployment

There are three pieces: a **private data repository** (where responses live), a
**Cloudflare Worker** (which validates and writes them), and the **static site** on
GitHub Pages. Deploy in that order.

Total cost: zero on both free tiers. Total time: about 30 minutes the first time.

> **Before you start, two facts that account for almost every failed deployment:**
>
> 1. The **site** repository must be **public**. GitHub Free publishes Pages only from
>    public repositories. The **data** repository in step 1 must be **private**. They are
>    two different repositories and that contrast is deliberate.
> 2. `git push` does **not** publish a website. Pages must be enabled once in
>    **Settings → Pages** (step 6.3). Until then the site URL answers *"There isn't a
>    GitHub Pages site here."* even though the code is safely on GitHub.

```
participant's browser
        │  HTTPS + JSON (no secret in the page)
        ▼
Cloudflare Worker  ──▶  Workers KV       (instant, durable buffer)
        │  every 2 minutes, or immediately on submit
        ▼
GitHub API  ──▶  private repo honeray/maelstrom-study-data

static site  ──▶  PUBLIC repo honeray/maelstrom-study  ──▶  GitHub Pages
```

---

## 0. What you need

- The GitHub account `honeray` (or any account — update `docs` and `wrangler.toml` if it
  differs).
- A free Cloudflare account.
- Node.js 20+ and `git` locally.

---

## 1. Create the private data repository

1. On GitHub: **New repository** → name `maelstrom-study-data` → **Private** → create with
   a README.
2. Nothing else is needed. The worker creates folders as it writes.

The repository stays private. Participants never see it; the site never links to it.

## 2. Create a fine-grained GitHub token

**Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate
new token.**

- **Repository access**: *Only select repositories* → `maelstrom-study-data`.
- **Permissions → Repository permissions → Contents**: **Read and write**.
- Everything else: *No access*.
- **Expiration**: set a real date (90–365 days) and put a reminder in your calendar. When
  it expires, responses stop syncing — the site keeps working locally, but you must
  rotate the token with `wrangler secret put GITHUB_TOKEN`.

Copy the token (`github_pat_…`). It is a secret: never commit it, never put it in the
repository, never paste it into the browser.

## 3. Create the KV namespace

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create MAELSTROM_KV
```

Wrangler prints an `id`. Paste it into `worker/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "MAELSTROM_KV"
id = "0123456789abcdef0123456789abcdef"
```

KV is the durable buffer: every save lands here within milliseconds, and the git commit
happens afterwards. Nothing is lost if GitHub is slow or rate-limited.

## 4. Configure and deploy the worker

Edit `worker/wrangler.toml`:

```toml
[vars]
DATA_REPO = "honeray/maelstrom-study-data"
GIT_BRANCH = "main"
SURVEYS = "delphi-round-1,delphi-round-2"     # ← add new survey ids here
ALLOWED_ORIGINS = "https://honeray.github.io" # ← the Pages origin, no trailing slash
RATE_LIMIT_PER_MINUTE = "90"
```

`SURVEYS` is an allow-list. If you forget to add a new survey id here, its saves are
rejected with `survey_unknown` and participants see "Not saved to server".

Then set the two secrets and deploy:

```bash
npx wrangler secret put GITHUB_TOKEN     # paste the fine-grained token
npx wrangler secret put ADMIN_TOKEN      # any long random string; used only for /v1/flush
npx wrangler deploy
```

Wrangler prints the URL, e.g. `https://maelstrom-api.<subdomain>.workers.dev`.

### Smoke test

```bash
curl https://maelstrom-api.<subdomain>.workers.dev/v1/health
# {"ok":true,"service":"maelstrom-collector","time":"..."}

curl -X POST https://maelstrom-api.<subdomain>.workers.dev/v1/save \
  -H "content-type: application/json" \
  -d '{"surveyId":"delphi-round-1","tag":"ZZZZZZZZ","answers":{},"final":false}'
# {"ok":true,"updatedAt":"...","committed":false}
```

A `final: true` save commits immediately; otherwise the 2-minute cron commits it.
Check `https://github.com/honeray/maelstrom-study-data/tree/main/data` a moment later.

Delete the test record when you are done:

```bash
# in the data repository
git rm data/delphi-round-1/ZZZZZZZZ.json
```

### Custom domain (recommended for participants in mainland China)

`*.workers.dev` is frequently unreachable from mainland China. If your panel includes
Chinese experts, attach a custom domain in **Cloudflare → Workers → your worker →
Settings → Domains & Routes → Add custom domain** (any domain you own, proxied through
Cloudflare). Then set `apiBase` to that domain.

## 5. Point the site at the worker

Edit `assets/js/config.js`:

```js
apiBase: 'https://maelstrom-api.your-subdomain.workers.dev',
```

Commit and push. That is the only change the front end needs.

> Leave `apiBase` empty and the site still runs, but answers stay in the participant's
> browser and every page shows an amber warning strip. Never share a survey link in that
> state.

## 6. Publish the site on GitHub Pages

> ### The site repository must be **public**
>
> GitHub Free publishes Pages **only from public repositories**. Private repositories
> need GitHub Pro, GitHub Team or Enterprise.
>
> This is the most common way this deployment appears to fail. If `maelstrom-study` is
> created as **private**, `git push` succeeds exactly as documented, everything looks
> fine, and then the Pages settings never offer a branch to publish — the URL simply
> answers *"There isn't a GitHub Pages site here."*
>
> Making the site repository public is safe and intended. It contains the questionnaire
> and its UI only; **every response lives in the separate private
> `maelstrom-study-data` repository** from step 1, and no token ever reaches the browser.

A successful `git push` does **not** publish a site. Pages has to be enabled once, in
the repository settings; after that every push to `main` redeploys automatically.

### 6.1 Create the repository as public

With the GitHub CLI, which creates it with the right visibility in one step:

```bash
gh repo create maelstrom-study --public --source=. --remote=origin --push
```

Or in the web UI: **New repository** → name `maelstrom-study` → **Public** (not
Private) → *Create repository*, then:

```bash
git add .
git commit -m "MAELStrOM study site"
git branch -M main
git remote add origin https://github.com/honeray/maelstrom-study.git
# if origin already exists: git remote set-url origin https://github.com/honeray/maelstrom-study.git
git push -u origin main
```

### 6.2 Check the name and visibility before going further

```bash
git remote -v
# origin  https://github.com/honeray/maelstrom-study.git (fetch)
# origin  https://github.com/honeray/maelstrom-study.git (push)

gh repo view honeray/maelstrom-study --json name,visibility,hasPages
# {"hasPages":false,"name":"maelstrom-study","visibility":"PUBLIC"}
```

Then open <https://github.com/honeray/maelstrom-study> **in a private window** (signed
out). If it returns 404, the repository is private or has a different name — fix that
first, because nothing else can work until it is public.

The repository name also becomes the URL path. If you named it something else (for
example `maelstrom-study-site`), your address will be
`https://honeray.github.io/<that-name>/`. All links in the site are relative, so any
name works without code changes.

### 6.3 Enable Pages

**Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch:
`main` / folder `/(root)` → Save.**

That branch selector only appears for a public repository (or on a paid plan). After
saving, GitHub reports "Your site is live at …" and a `pages build and deployment` run
appears under the **Actions** tab.

### 6.4 Done

<https://honeray.github.io/maelstrom-study/> — allow a minute or two for the first
deployment; later pushes go live in seconds.

The repository contains `.nojekyll`, which stops GitHub from running Jekyll and keeps
every file exactly as committed.

### If you must keep the code private

Two options that both work:

- **GitHub Pro** (free for students through the GitHub Student Developer Pack) enables
  Pages from private repositories; the published site is still public.
- Keep the code private and push only the site to a **separate public repository**
  (delete `worker/` from that copy if you prefer).

## 7. Verify the whole chain

1. Open the homepage. There must be **no amber warning strip**.
2. Enter Round 1, generate a tag, answer page 1 and press Continue.
3. Within ~10 seconds the header should read **Saved** (not "Saved on this device").
4. Check `maelstrom-study-data/data/delphi-round-1/<TAG>.json` — a commit appears within
   two minutes (or instantly after submitting).
5. Submit the survey. The thank-you page appears and the JSON record changes to
   `"final": true`, with a copy under `data/delphi-round-1/submitted/`.

## 8. Reopening or closing rounds

`data/surveys.json` drives the homepage:

| `status` | Homepage | Can be opened? |
|---|---|---|
| `scheduled` | greyed, "Opens later" | no |
| `open` | blue banner, "Enter" | yes |
| `closed` | greyed, "Closed" | no, unless a draft already exists locally |

A participant who already started a round can still finish it after you set `closed`,
so nobody loses work.

## 9. Updating the worker later

```bash
cd worker
npx wrangler deploy            # after editing src/index.js or wrangler.toml
npx wrangler tail              # live logs
```

**Deploy after any change to the site's address.** `ALLOWED_ORIGINS` is an
environment variable baked into the worker at deploy time: editing
`worker/wrangler.toml` and pushing the site changes nothing until you run
`npx wrangler deploy`. Moving the site to a custom domain, renaming the
repository, or switching between `username.github.io` and a domain are all
origin changes, and every save is blocked until the worker is redeployed.

The origin must match exactly — scheme included, no trailing slash — and a
`www.` host is a different origin from the apex, so add it separately if it
serves the site without redirecting.

`npm run doctor` checks this directly: it resolves the origin the published site
actually runs at and asks the worker whether it accepts it.

Cron triggers are part of the deployment; `*/2 * * * *` is already configured. To flush
outstanding records immediately:

```bash
curl "https://maelstrom-api.<subdomain>.workers.dev/v1/flush?token=<ADMIN_TOKEN>"
```

## 10. Troubleshooting

Run the doctor first — it checks the remote, repository visibility, Pages status, the
live URL and the worker in one pass and prints the fix for whatever is wrong:

```bash
npm run doctor
# or, to inspect a repository private to the world:
GITHUB_TOKEN=github_pat_… node tools/doctor.mjs --repo honeray/maelstrom-study
```

| Symptom | Cause | Fix |
|---|---|---|
| **`git push` works but the site URL says "There isn't a GitHub Pages site here."** | **Pages was never enabled, or the repository is private on GitHub Free** | **Make the repository public (Settings → General → Danger zone → Change visibility) and enable Pages (§6.3). `git push` alone never publishes a site.** |
| <https://github.com/honeray/maelstrom-study> 404s when signed out | repository is private, or has a different name | Make it public; `git remote -v` to confirm the name |
| Settings → Pages has no branch selector / shows an upgrade prompt | private repository on GitHub Free | Make it public, or use GitHub Pro (free with the Student Developer Pack) |
| Pages build fails under the Actions tab | usually Jekyll trying to process the files | Confirm the dot-file is committed: `git ls-files --error-unmatch .nojekyll` |
| Amber strip on every page | `apiBase` is empty or malformed | Set it in `assets/js/config.js` |
| Header says "Saved on this device" forever | Worker unreachable | Check `/v1/health`; check `ALLOWED_ORIGINS` |
| Browser console shows a CORS error | Origin not in `ALLOWED_ORIGINS` | Add the exact origin, including `https://`, no trailing slash |
| `403 origin_not_allowed` | Same | Same |
| **Saves worked, then stopped right after the site moved to a custom domain** | **The site's origin changed, but the deployed worker still has the old `ALLOWED_ORIGINS`** | **`cd worker && npx wrangler deploy`, then `npm run doctor` — it now tests the site's real origin and prints this fix. Editing `wrangler.toml` alone changes nothing until you deploy.** |
| `survey_unknown` in the network tab | Survey id missing from `SURVEYS` | Add it and redeploy |
| `429 rate_limited` | More than 90 saves/minute from one IP | Usually a proxy/NAT; raise `RATE_LIMIT_PER_MINUTE` |
| Records never reach GitHub | Expired token or wrong repo name | `wrangler tail`, then rotate `GITHUB_TOKEN` |
| Tag lookup says "No earlier responses" but the participant submitted | Different data repository, or the participant mistyped the tag | Check the record in the data repository |
| Pages shows 404 for a survey | `data/surveys.json` points at a missing file | `npm run validate` |

## 11. Backups

The data repository **is** the backup: every response is a plain JSON file with full
history in git.

```bash
git clone https://github.com/honeray/maelstrom-study-data.git
```

Migrating away later is straightforward — export the JSON files to CSV, or point
`assets/js/lib/api.js` at any backend that implements the same four endpoints
(`/v1/health`, `/v1/save`, `/v1/load`, `/v1/status`). That file is the only place the
site talks to the network for responses.
