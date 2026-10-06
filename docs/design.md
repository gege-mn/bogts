# Bogts: design

Status: **decided; being built** (see the README's status). The binding API
shapes are in `docs/contracts.md`. The reasons behind each choice are in
`docs/decisions.md`.

## What it is

Bogts is an open-source, self-hosted payment gateway for Mongolian
payment providers, running as a single Cloudflare Worker. A company deploys its
own copy with the **Deploy to Cloudflare** button and enters its own Bonum and
QPay credentials. Its projects then call one small API instead of talking to
each provider.

- **One deployment serves one company**, which can have **many projects**. Each
  project has its own API key, webhook URL and plans.
- **It is a low-level gateway.** It reports payment facts: charged, failed,
  renewed, cancelled, expired. Each project decides what those facts entitle a
  customer to.
- **Money goes straight to the company's own merchant accounts.** The service
  never holds funds.
- **Projects never see provider credentials or card tokens.**

## Boundary

| Bogts owns | Each project owns |
|---|---|
| Provider credentials (Worker secrets) and provider API tokens, which are cached in D1 and shared across isolates | Entitlement: plan, `paid_until`, grace |
| Card tokens, encrypted at rest | The UI: the project redirects to the checkout URL, or shows the QR, that it gets back |
| Mandates, invoices, webhook checksums, and a ledger that applies each payment exactly once | Acting on events once each, keyed by `event.id` |
| Plan catalog: plan key → provider plan id, amount, interval | Choosing which plan key to sell |
| Event outbox with retries, and the expiry sweep | |

## v1 flows

1. **Bonum card subscriptions:** tokenize with a subscription, renewals,
   failure and retry, `UNSUBSCRIBED`, card replacement, cancel (`/delete` with
   `planId`).
2. **QPay one-off invoices (direct):** a QR plus bank deeplinks, a payment
   check, and callbacks.
3. **Bonum hosted invoice (All-in-one):** QPay, card, WeChat and SonoShop on
   Bonum's checkout page.
4. **Charging a saved card (Bonum purchase):** results can come back at once or
   queued (`TOKEN-PAYMENT` webhook), and a charge can be reversed.

## API

`https://<host>/v1`, authenticated with `Authorization: Bearer <project API key>`.

- `POST /v1/invoices` takes `{ provider: 'qpay' | 'bonum', amount, reference, description, returnUrl?, expiresIn? }` and returns the Invoice object (`payUrl`, `redirectUrl`, `qr`, `deeplinks`; see `docs/contracts.md`).
- `POST /v1/subscriptions` takes `{ plan, customerRef, email?, returnUrl }` and returns `{ id, redirectUrl }`.
- `DELETE /v1/subscriptions/:id` cancels a subscription.
- `POST /v1/subscriptions/:id/card` starts a card replacement and returns `{ redirectUrl }`.
- `POST /v1/charges` charges a saved card. It takes `{ subscriptionId, amount, reference }` and charges that subscription's card. `POST /v1/charges/:id/reverse` reverses it.
- `GET /v1/invoices/:id`, `GET /v1/subscriptions/:id` and `GET /v1/charges/:id` read state.
- `GET /v1/events?after=<id>` is the event feed, for a project to reconcile after an outage.
- Provider webhooks arrive at `POST /hooks/bonum` and `POST /hooks/qpay/:invoiceId`.

## Events

Each event is POSTed to the project's webhook URL with the header
`Bogts-Signature: t=<unix>,v1=<hmac-sha256>`, computed with the project's
signing secret. Delivery goes through an outbox table (no Cloudflare Queues: the first attempt
runs inline, then an every-minute cron retries),
retrying with exponential backoff for up to 3 days until the project answers 2xx.

The event types are:
- `invoice.paid`, `invoice.expired`, `invoice.failed`
- `subscription.active`, `subscription.renewed`, `subscription.payment_failed`, `subscription.cancelled`, `subscription.card_changed`
- `charge.succeeded`, `charge.failed`, `charge.reversed`
- `card.saved`, `card.failed`, `card.replaced`, `card.removed`

Each event is `{ id, object: 'event', type, createdAt, data }`; `data` carries the
reference or `customerRef`, `amount`, `currency`, and `period` / `nextBillAt` where
they apply (`docs/webhooks.md`).

**Expiry sweep:** a cron runs every 10 minutes. Each invoice past its
`expiresAt` with no final state is checked **exactly once**:
- **QPay:** the payment-check API. If paid, it emits `invoice.paid`; otherwise
  `invoice.expired`. About 24 h later an expired QPay invoice is checked one
  more time, since QPay still accepts payment on an old QR and its callback
  can be lost.
- **Bonum:** its status endpoint is test-only, so the invoice is marked expired
  locally, 2 h after `expiresAt` so Bonum's webhook retries can land.

**Renewal reconciliation:** hourly, a subscription whose renewal is over 6 h
overdue is looked up at Bonum and credited, cancelled or marked past due. A
renewal is deduplicated by its billing period, so the reconciled credit and a
late webhook never both count (`docs/contracts.md`, "As built (hardening)").

## Dashboard

A SvelteKit app, in the same Worker, under `/admin`. v1 covers payments,
subscriptions, events with re-delivery, projects (keys, webhook URL, plans),
cancelling a mandate, reversing a charge, and a usage meter.

**Auth:** Cloudflare Access if `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` are
set; otherwise a single admin password set when deploying. **The Worker refuses
to serve `/admin` or `/v1` when neither is configured**, so an unconfigured
deploy never runs open.

## Data (D1, Drizzle)

- `project`: name, API key hash, webhook URL, signing secret
- `plan`: project, key, provider, provider plan id, amount, interval
- `invoice`: provider, amount, reference, status, expiresAt, sweptAt, provider ids
- `subscription`: project, plan, customerRef, status, provider subscription id, card id, nextBillAt
- `card`: encrypted token, mask, bank, expiry
- `charge`: card, amount, reference, status
- `ledger`: provider payment ref (unique), for applying each payment once
- `provider_token`: the Bonum and QPay access-token cache
- `event` and `delivery`: the outbox
- `ebarimt_*`: reserved columns only. e-barimt is a later version.

## Configuration (Deploy button prompts)

The Deploy button prompts for the entries in `.dev.vars.example`:

- **Bonum:** `BONUM_ENVIRONMENT`, `BONUM_APP_SECRET`, `BONUM_TERMINAL_ID`, `BONUM_CHECKSUM_KEY`
- **QPay:** `QPAY_ENVIRONMENT`, `QPAY_CLIENT_ID`, `QPAY_CLIENT_PASSWORD`, `QPAY_INVOICE_CODE`
- **Security:** `ENCRYPTION_KEY` (32 bytes, base64), `PUBLIC_ORIGIN`, and `ADMIN_PASSWORD` unless Access is configured (`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`)

A provider whose credentials are left empty is simply switched off.

## Repo

This is a pnpm monorepo:
- `apps/gateway`: SvelteKit on Cloudflare Workers
- `packages/client`: `@gege-mn/bogts`, the typed API client plus a
  webhook signature helper

The license is Apache-2.0. The Deploy button sits at the top of the README.

## Fixes built in from day one

See [providers/bonum-pitfalls.md](providers/bonum-pitfalls.md):
- renewals are keyed on `invoiceId`, with a guard against crediting the first charge twice;
- `UNSUBSCRIBED` is handled;
- delete sends `planId`;
- the checksum keeps number text exactly as sent;
- the access token is shared across isolates.
