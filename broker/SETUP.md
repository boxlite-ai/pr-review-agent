# Publishing the `@boxlite` bot (auto-install)

Turns the reviewer into an installable GitHub App: users click **Install**, paste their
BoxLite + Claude keys once, and their repos get the review workflow + secrets written
automatically — no hand-written workflow, no per-repo secret setup.

Everything here is scripted. Your part is **two authenticated clicks and one command**; the
app-creation flow, key exchange, secret loading, and deploy are automated.

## Prerequisites
- `gh` logged in — `gh auth status`
- A Cloudflare account — `npx wrangler login`

## 1 · Create the App — one click
Open **`create-app.html`** in a browser → **Create GitHub App** → authenticate. It's
pre-filled with the exact permissions (Contents/Secrets/Workflows/Pull requests/Checks) and
settings; you only confirm. GitHub redirects to `https://boxlite.ai/app-created?code=XXXX` —
copy the `code`.

## 2 · Deploy the broker — one command
```
cd broker
bash deploy.sh XXXX
```
Exchanges the code for the App ID + private key, loads them as Worker secrets, deploys, and
prints your Worker URL.

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
