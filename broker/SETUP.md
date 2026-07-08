# Publishing the `@boxlite` bot (auto-install)

Turns the reviewer into an installable GitHub App: users click **Install**, paste their
BoxLite + Claude keys once, and their repos get the review workflow + secrets written
automatically — no hand-written workflow, no per-repo secret setup.

Your part is a short App-registration form + one `wrangler login`; the PKCS#8 conversion,
secret loading, and deploy are scripted (`deploy.sh`).

## Prerequisites
- `gh` logged in — `gh auth status`
- A Cloudflare account — `npx wrangler login`

## 1 · Create the App
**Settings → Developer settings → GitHub Apps → New GitHub App** (org:
`github.com/organizations/<org>/settings/apps/new`). Fill in:
- **Name** `boxlite` · **Homepage URL** `https://boxlite.ai`
- **Webhook** → uncheck **Active**
- **Repository permissions** → **Read and write** on: Contents, Secrets, Workflows,
  Pull requests, Checks
- **Where can this be installed** → **Any account**
- Click **Create GitHub App**, then **Generate a private key** (saves a `.pem`) and copy
  the **App ID**.

> Why not the `create-app.html` one-click manifest: GitHub's session cookie is `SameSite`,
> so it isn't sent on the cross-origin manifest POST — the App can't be created that way.
> Use the form above.

## 2 · Deploy the broker — one command
```
cd broker
npx wrangler login                                  # once
bash deploy.sh <APP_ID> <path-to-private-key.pem>
```
Loads APP_ID + the key as Worker secrets, deploys, and prints your Worker URL.

## 3 · Point the App at the broker — one field
The script prints the exact link + value. In the App settings set
**Setup URL = `https://<your-worker>.workers.dev/setup`** and check *Redirect on update*.

## Done
Share `https://github.com/apps/<slug>/installations/new`. Anyone who installs lands on the
setup form, pastes their two keys, and their repos self-configure.

## Where secrets live
- The App **private key** exists only as a Worker secret (keep a copy in a password manager).
- Installers' BoxLite/Claude keys pass through `/setup` once, to be written as **their** repo
  secrets (libsodium sealed-box) — the broker never stores them.
- `/exchange` mints short-lived, repo-scoped `@boxlite[bot]` tokens from the verified OIDC
  claim; the App key never leaves the Worker.

> Security note: `/setup` can write secrets + workflows into any installing repo. It's new and
> not yet load-tested — review it before opening the App publicly.
