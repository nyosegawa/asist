---
name: website
description: How to change, check and publish ASIST's website at asist-agent.com (website/, a static page served by a Cloudflare Worker), with the Cloudflare login kept inside this repository. Use when asked to edit, preview, build, deploy, publish or roll back the website or landing page (紹介ページ、LP、サイト、asist-agent.com、デプロイして、公開して、サイトに反映して、Cloudflare、wrangler), or when wrangler reports the wrong account or no login. Do not use for the app's own screens (visual-debugging) or for rebuilding the promotional video, which only reads the website's images.
---

# The website

`website/` is one static page. Vite builds it into `website/dist`, and the Worker `asist-website` (`website/wrangler.jsonc`, `website/worker.js`) serves it at asist-agent.com and sends www.asist-agent.com there with a 301. The domain and its DNS are on the same Cloudflare account.

## 1. Change and look

```bash
npm run website          # http://localhost:5194
npm run website:build    # website/dist
```

- Look at the page at desktop width and at phone width (about 390 px). Sections appear on scroll (`data-in`), so scroll to what you changed before judging it.
- The dev server listens on this Mac only. To open it from a phone, start it with `npm run website -- --host` for the check alone: that serves it on every network the Mac is on, including shared Wi-Fi.
- Pictures in `website/public/` are also used by the promotional video (`promotions/x-promo-video/`). When one changes, say so in the report, since the next video changes with it.
- A change reaches main through a pull request like any other (`pull-request`). Publish from main, never from a branch.

## 2. Log in (once per checkout)

Always run wrangler as `npm run cf -- <command>`, never `npx wrangler`. `scripts/wrangler.mjs` points wrangler at a login stored in `.wrangler/config` of this checkout, so the account wrangler uses elsewhere on this Mac is never touched. It removes `CLOUDFLARE_API_TOKEN` and the other `CLOUDFLARE_*` variables, which would take precedence over the login, and it stops when `~/.wrangler` exists, since wrangler would then read that login instead.

```bash
npm run cf -- whoami
```

- "You are not authenticated": ask the user to run `npm run cf -- login` and sign in, in the browser, with the Cloudflare account that holds asist-agent.com. You cannot sign in for them.
- Check that the account id `whoami` prints is the `account_id` in `website/wrangler.jsonc`. If it differs, stop and ask; deploying would create the Worker in the wrong account.
- A git worktree has its own `.wrangler/`, so it needs its own login. Publishing from the main checkout avoids that.

## 3. Publish

Publishing changes a public site, so do it only when the user has asked for it.

```bash
git switch main && git pull --ff-only
npm run website:deploy   # builds website/dist and deploys the Worker with its assets
```

Then check the live site, not the build:

```bash
curl -sI https://asist-agent.com/ | head -1                           # 200
curl -sI https://www.asist-agent.com/img/hero.png | grep -i -E '^(HTTP|location)'   # 301 to https://asist-agent.com/img/hero.png
curl -s https://asist-agent.com/ | grep -c '<the text you changed>'
```

Open https://asist-agent.com/ in the browser pane as well and look at what changed. Report the commit you published and what you saw.

## 4. Undo a publication

```bash
npm run cf -- deployments list --config website/wrangler.jsonc
npm run cf -- rollback <version-id> --config website/wrangler.jsonc
```

A rollback only changes what is served. Fix main afterwards through a pull request, or the next deploy brings the problem back.

## Notes

- `npm run cf -- deploy --config website/wrangler.jsonc --dry-run` checks the configuration and the Worker without logging in.
- `npm run cf -- dev --config website/wrangler.jsonc --host www.asist-agent.com` runs the Worker locally as if requests came to www, which is how to check the redirect before publishing. Without `--host`, `wrangler dev` rewrites the request's host to localhost and the redirect never fires.
