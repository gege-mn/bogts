# Self-hosting Bogts

Bogts is one Cloudflare Worker (`apps/gateway`) with one D1 database. It runs
on the Workers Free plan, but use Workers Paid for real money: the Free plan
allows 10 ms of CPU per request and keeps only 7 days of D1 backups (30 on
Paid).

- [Before you start](#before-you-start)
- [Path A: the Deploy button](#path-a-the-deploy-to-cloudflare-button)
- [Path B: wrangler by hand](#path-b-wrangler-by-hand)
- [Configuration reference](#configuration-reference)
- [Admin auth](#admin-auth)
- [Bonum setup](#bonum-setup)
- [QPay setup](#qpay-setup)
- [Sandbox and production](#sandbox-and-production)
- [Your first project](#your-first-project)
- [Custom domain](#custom-domain)
- [Upgrading and migrations](#upgrading-and-migrations)
- [Backups](#backups)
- [Troubleshooting](#troubleshooting)

## Before you start

You need:

- a Cloudflare account;
- a GitHub or GitLab account (Path A only);
- merchant credentials from Bonum, QPay or both. You can start with the QPay
  sandbox, whose test merchant is public (see [QPay setup](#qpay-setup)).

Generate the encryption key now and **store it in your password manager**.
Cloudflare never shows a secret again after you save it, and without this key
the saved card tokens in your database are unreadable.

```sh
openssl rand -base64 32
```

Decide the public origin: either your `workers.dev` address,
`https://bogts.<your-subdomain>.workers.dev` (the Worker name, then your
account's subdomain, which is shown under **Workers & Pages** in the
dashboard), or a custom domain such as `https://pay.example.com`. You can change
it later.

## Path A: the Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gege-mn/bogts/tree/main/apps/gateway)

The button deploys only `apps/gateway`. Cloudflare:

1. copies `apps/gateway` into a **new repository in your GitHub or GitLab
   account**, which becomes the root of that repository;
2. creates a **D1 database** for the `DB` binding (you can rename it) and
   writes its id into your copy of `wrangler.jsonc`;
3. asks for each **secret** listed in `.dev.vars.example`, with the
   descriptions from `package.json`;
4. builds and deploys with **Workers Builds**: the build command is
   `pnpm run build` and the deploy command is `pnpm run deploy`, which applies
   the D1 migrations and then runs `wrangler deploy`.

On the setup page:

- **`ENCRYPTION_KEY`**: the key you generated above.
- **Admin auth**: `ADMIN_PASSWORD` (12 characters or more), or both
  `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` (see [Admin auth](#admin-auth)).
- **`PUBLIC_ORIGIN`**: the origin you chose, with `https://` and no path.
- **Providers**: fill in all three secrets of each provider you use and leave
  the other provider's empty. A provider with any secret missing is switched
  off. If the form insists on a value, enter anything and delete that secret
  afterwards under **Settings → Variables and Secrets**.
- **`*_ENVIRONMENT`**: `test` for a sandbox, otherwise `production`.

When the build finishes, open `https://<your origin>/health`. It should answer
`{"status":"ok","configured":true,"database":true}`. Then go to `/admin`.

From now on, every push to your new repository rebuilds and redeploys the
Worker.

## Path B: wrangler by hand

Requires Node 24 or later and pnpm.

```sh
git clone https://github.com/gege-mn/bogts.git
cd bogts
pnpm install
cd apps/gateway
pnpm wrangler login
pnpm wrangler d1 create bogts
```

Paste the printed `database_id` into the `d1_databases` entry of
`apps/gateway/wrangler.jsonc`. Wrangler can also find the database by its name,
but the id makes every deploy independent of that lookup. Then deploy:

```sh
pnpm run deploy   # vite build, D1 migrations, wrangler deploy
```

Use `pnpm run deploy`, not `pnpm deploy`. `pnpm deploy` is a built-in pnpm
command that does something else.

The Worker is now live, and it answers `503 not_configured` until it has its
secrets. Set them one at a time:

```sh
pnpm wrangler secret put ENCRYPTION_KEY
pnpm wrangler secret put ADMIN_PASSWORD
pnpm wrangler secret put PUBLIC_ORIGIN
pnpm wrangler secret put QPAY_ENVIRONMENT
# …and so on, for the names in .dev.vars.example
```

Or set them all at once from a JSON file that you delete afterwards:

```sh
pnpm wrangler secret bulk secrets.json
```

Each secret change takes effect immediately, without a redeploy.

To keep your own settings out of the upstream file, keep your own configs (for
example a staging and a production wrangler config, each copied from
`wrangler.jsonc`) in a separate private repo and deploy with `-c`.

## Configuration reference

All configuration is Worker secrets. The names are in
[`apps/gateway/.dev.vars.example`](../apps/gateway/.dev.vars.example).

| Name | Required | Meaning |
|---|---|---|
| `ENCRYPTION_KEY` | yes | 32 random bytes, base64. Encrypts card tokens, provider tokens and webhook signing secrets. **Never change it after the first payment.** |
| `ADMIN_PASSWORD` | one of the two admin options | The `/admin` password, at least 12 characters. Ignored when Access is configured. |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | one of the two admin options | Cloudflare Access for `/admin`. Set both or neither. |
| `PUBLIC_ORIGIN` | for any provider | `https://…`, the origin only. Providers call back here, and QPay's hosted page lives here. |
| `BONUM_ENVIRONMENT` | no | `production` (the default when empty) or `test` |
| `BONUM_APP_SECRET`, `BONUM_TERMINAL_ID`, `BONUM_CHECKSUM_KEY` | all three for Bonum | From Bonum. |
| `QPAY_ENVIRONMENT` | no | `production` (the default when empty) or `test` |
| `QPAY_CLIENT_ID`, `QPAY_CLIENT_PASSWORD`, `QPAY_INVOICE_CODE` | all three for QPay | From QPay. |

**Bogts fails closed.** While any of the following is true, `/v1`, `/hooks` and
`/admin` answer `503 not_configured`, with a message that names the variables
but never their values:

- `ENCRYPTION_KEY` is missing, or is not base64 for exactly 32 bytes;
- there is no admin auth: neither Access nor `ADMIN_PASSWORD`;
- only one of the two Access variables is set;
- `ADMIN_PASSWORD` is shorter than 12 characters;
- an `*_ENVIRONMENT` is something other than `production` or `test`;
- `PUBLIC_ORIGIN` is not `https://` (plain `http://localhost` is allowed for
  development) or has a path.

A provider with only some of its secrets, or without `PUBLIC_ORIGIN`, doesn't
take the gateway down. It is switched off and listed as a warning under
**Settings** in the dashboard. `/health` never shows which settings are
missing.

## Admin auth

**Cloudflare Access (recommended).** In the Zero Trust dashboard, go to
**Access → Applications → Add an application → Self-hosted**. Protect
`<your host>/admin` with the policy you want, for example emails ending in
`@example.com`. Then set:

- `CF_ACCESS_TEAM_DOMAIN`: your team domain, such as
  `yourteam.cloudflareaccess.com`;
- `CF_ACCESS_AUD`: the application's **Application Audience (AUD) tag**.

Bogts verifies the `Cf-Access-Jwt-Assertion` JWT on every `/admin` request
against your team's keys. The password is then ignored, so it can't be used to
get around Access.

Protect **only `/admin`**. Your projects call `/v1`, providers call `/hooks`,
and payers open `/pay`. With Access in front of those, payments stop.

Access only sits in front of the hostnames you give it. On any other address
of the same Worker (`workers.dev`, preview URLs) there is no Access JWT, so
Bogts refuses `/admin` there. With a custom domain, turn those addresses off
anyway (`"workers_dev": false` and `"preview_urls": false` in
`wrangler.jsonc`).

**Password.** Set `ADMIN_PASSWORD` to 12 characters or more. Sessions last
12 hours in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Changing the
password, or `ENCRYPTION_KEY`, signs everyone out. Login is limited to 10
attempts per IP address and 100 failed attempts overall per 15 minutes; the
overall limit never refuses the right password.

## Bonum setup

1. Get your **App secret**, **Terminal ID** and **webhook checksum key** from
   Bonum and set `BONUM_APP_SECRET`, `BONUM_TERMINAL_ID` and
   `BONUM_CHECKSUM_KEY`.
2. In Bonum's merchant portal, set the webhook URL to
   `${PUBLIC_ORIGIN}/hooks/bonum`, for example
   `https://pay.example.com/hooks/bonum`. The dashboard's **Settings** page
   shows the exact URL to copy.
3. Create your **subscription plans in Bonum's portal**. Bonum owns plans;
   Bogts only maps to them.
4. In `/admin` → **Projects → Plans**, add each plan: a key your app will use
   (such as `pro-monthly`), the Bonum plan id, the amount in MNT and the
   interval. Bogts checks the plan against Bonum (amount, type and status). A
   plan that doesn't match is saved as a mismatch, and checkouts for it are
   refused with `plan_mismatch` until it's fixed.

Sandbox and production plans have different ids, so a staging deployment has
its own plans. More detail: [providers/bonum.md](providers/bonum.md).

## QPay setup

1. Get your **client id**, **client password** and **invoice code** from QPay,
   and set `QPAY_CLIENT_ID`, `QPAY_CLIENT_PASSWORD` and `QPAY_INVOICE_CODE`.
2. That's all. There is nothing to register. Each invoice carries its own
   callback URL, `${PUBLIC_ORIGIN}/hooks/qpay/<invoice id>`, which Bogts sets
   automatically.

For the sandbox, QPay's public test merchant works:

```
QPAY_ENVIRONMENT=test
QPAY_CLIENT_ID=TEST_MERCHANT
QPAY_CLIENT_PASSWORD=123456
QPAY_INVOICE_CODE=TEST_INVOICE
```

Nobody can actually pay the test merchant, so a sandbox invoice ends as
`expired` after the next expiry sweep. The sandbox also fails now and then;
Bogts marks that invoice `failed` and your app creates another one. More
detail: [providers/qpay.md](providers/qpay.md).

## Sandbox and production

| | `production` (the default) | `test` |
|---|---|---|
| Bonum | `https://apis.bonum.mn` | `https://testapi.bonum.mn` |
| QPay | `https://merchant.qpay.mn` | `https://merchant-sandbox.qpay.mn` |

An empty `*_ENVIRONMENT` means production, so a deployment that forgot the
setting can't quietly accept sandbox "payments" for real goods. When any
provider runs in `test`, the dashboard shows a sandbox banner.

**Run sandbox and production as two deployments**, each with its own Worker, D1
database and secrets. Plans, card tokens and provider ids from one environment
mean nothing in the other. Keep your own configs, e.g. a staging and a
production wrangler config, in a separate private repo and deploy each with
`-c`.

## Your first project

1. Open `/admin` → **Projects → New project**. Give it a name and your app's
   webhook URL (`https://`).
2. Copy the **API key** (`bgk_…`) and **signing secret** (`bgwh_…`) into your
   app's secrets. They are shown only once. After that, rotate them to get new
   ones. A rotated API key keeps working for 24 hours.
3. Call the API: see [api.md](api.md) and [webhooks.md](webhooks.md), or use
   [`@gege-mn/bogts`](../packages/client/README.md).

## Branding

Settings → Branding sets the company name, logo (PNG, SVG or WebP, up to
256 KB, stored in D1), accent colour, and an optional support email and URL
shown on payment pages. Each project can override the display name and logo
on its payment pages (project → General → Payment page), for companies that
run several brands. Every change is recorded in the audit log.

## Notifications

Settings → Notifications adds channels (Discord, Telegram, or a signed JSON
POST to your own URL) that get a message each time a payment is received, in
any project. A project can have channels of its own (project →
Notifications). They are optional and need no configuration variable: see
[notifications.md](notifications.md).

## Custom domain

Add the domain to your Cloudflare account, then either use **Workers & Pages →
bogts → Settings → Domains & Routes → Add → Custom domain**, or add it in
`wrangler.jsonc` and deploy:

```jsonc
"routes": [{ "pattern": "pay.example.com", "custom_domain": true }],
"workers_dev": false,
"preview_urls": false
```

Then:

1. set `PUBLIC_ORIGIN` to `https://pay.example.com`;
2. change the webhook URL in Bonum's portal;
3. point the Access application at the new host, if you use Access.

QPay invoices created before the change keep their old callback URL. Keep the
old address working until those invoices have expired, which by default takes
30 minutes (at most 24 hours).

## Upgrading and migrations

Database changes ship as numbered SQL files in `apps/gateway/drizzle/`.
`pnpm run deploy` applies any new ones (`wrangler d1 migrations apply DB
--remote`) **before** it deploys the new code. If a migration fails, the old
code keeps running. Migrations only move forward. Before any upgrade, note a
restore point (see [Backups](#backups)).

Read [CHANGELOG.md](../CHANGELOG.md) before upgrading.

**Path A.** Your repository holds a copy of `apps/gateway` without upstream's
history. To upgrade, copy the new release over it, keeping your own
`wrangler.jsonc`:

```sh
VERSION=X.Y.Z   # the release to upgrade to, from CHANGELOG.md
curl -L "https://github.com/gege-mn/bogts/archive/refs/tags/v$VERSION.tar.gz" | tar -xz
rsync -a --delete --exclude .git --exclude node_modules --exclude wrangler.jsonc \
  "bogts-$VERSION/apps/gateway/" ./
rm -rf "bogts-$VERSION"
diff <(curl -sL "https://raw.githubusercontent.com/gege-mn/bogts/v$VERSION/apps/gateway/wrangler.jsonc") wrangler.jsonc
git add -A && git commit -m "Upgrade Bogts to $VERSION" && git push
```

Apply any upstream `wrangler.jsonc` changes that the `diff` shows (such as a
new `compatibility_date` or cron) by hand, keeping your `database_id`. The push
redeploys the Worker.

**Path B.**

```sh
git pull
pnpm install
pnpm run deploy
```

## Backups

D1 **Time Travel** is always on. You can restore to any minute in the last 30
days (7 on the Workers Free plan).

```sh
cd apps/gateway   # "bogts" is the database name; use yours if you renamed it
pnpm wrangler d1 time-travel info bogts                            # the current bookmark: note it before an upgrade
pnpm wrangler d1 time-travel restore bogts --timestamp=1790000000  # or --bookmark=…
pnpm wrangler d1 export bogts --remote --output=bogts-$(date +%F).sql  # a copy you keep
```

A restore replaces the database in place and prints a bookmark that undoes it.
It also rewinds payments: anything that happened after the restore point is
still known to Bonum and QPay, but no longer to Bogts. After a restore, compare
the dashboard with the providers' merchant portals.

**The database is not enough on its own.** Card tokens and signing secrets in
it are encrypted with `ENCRYPTION_KEY`. Cloudflare can't show a secret back to
you, so keep that key in your password manager.

## Troubleshooting

- **Every `/v1` or `/admin` request answers `503 not_configured`.** The message
  names what's missing. See [Configuration reference](#configuration-reference).
- **`Couldn't find a D1 DB named 'bogts'`** during `pnpm run deploy`: create
  the database first with `pnpm wrangler d1 create bogts` (Path B).
- **A Workers Build fails at the deploy step with a pnpm error about
  `deploy`.** The deploy command must be `pnpm run deploy`. Fix it under
  **Settings → Build → Deploy command**.
- **`/health` says `"database": false`.** The `DB` binding is missing or the
  migrations haven't run. Run `pnpm wrangler d1 migrations apply DB --remote`.
- **Webhooks to your app never arrive.** Check the project's webhook URL. The
  dashboard's **Events** page shows every attempt with its HTTP status. Redirects
  count as failures: use the final URL.
- **A provider shows as off.** All three of its secrets and `PUBLIC_ORIGIN`
  must be set. The dashboard's **Settings** page lists what's missing.
- **Settings shows the cron hasn't run** a few minutes after the first
  deploy: re-apply the schedule with `pnpm wrangler triggers deploy` (from
  `apps/gateway`). On one deployment the first deploy's schedule never fired
  until it was re-applied.
