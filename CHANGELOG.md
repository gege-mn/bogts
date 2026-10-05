# Changelog

All notable changes to Bogts are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may
change the API; the notes will say how to upgrade.

## [Unreleased]

### Added

- **Saved cards** (`/v1/cards`): save a card for a `customerRef` with no Bonum
  payment plan, with an optional first payment, and replace or remove it.
  Bonum never charges such a card on its own. A customer can have several.
  New events: `card.saved`, `card.failed`, `card.replaced`, `card.removed`.
- **Charges by card**: `POST /v1/charges` takes `cardId` in place of
  `subscriptionId`, for any amount. The charge object and `GET /v1/charges`
  gained `cardId`.
- **Line items**: invoices, charges and a card's first payment take `items`
  (`{ label, amount, quantity }`) in place of `amount`. A discount is a line
  with a negative amount. The lines come back on the object and in its events.
- **Dashboard: Cards.** A Cards page lists saved cards and card steps; a
  card's page shows its charges, events and timeline, and can charge or remove
  it. "Save a card" starts a card step from the dashboard. Payment and charge
  pages show line items, and search finds cards by id or customer ref.
- **`GET /v1/invoices/:id` re-checks QPay**: while a QPay invoice is pending
  and unexpired, reading it asks QPay (at most once per 10 s per invoice, the
  same allowance the hosted page's poll uses) and settles a payment it finds.
  A project that shows its own QR can now poll with its API key instead of the
  public `/pay/:id/status`, whose per-address limit every Worker of a project
  shares.

### Fixed

- **Bonum webhook answers are JSON**: `/hooks/bonum` answered with bare text
  (`SUCCESS`), which Bonum's sender can't parse. A payment was applied, but
  Bonum's merchant portal logged the delivery as failed ("Unrecognized token
  'SUCCESS'"). Every answer is now `{"status": <http status>, "message":
  "<CODE>"}` with `application/json`; the codes are unchanged.

### Changed

- **Accent**: Bogts' default accent is now the pouch blue from the logo
  (`#0d47d2`), replacing the turquoise `#0e7c7b`. Deployments with their own
  accent in Settings → Branding are unchanged.
- **Mark**: the payment pages and dashboard show the real Bogts logo (the
  blue pouch with an orange cord) in its own colours, never tinted with the
  company accent: in the "Bogts" footer credit, the paid moment, and wherever
  no company logo is set. The dashboard favicon without a company logo is now
  this logo instead of an accent tile.
- **Payment pages**: on wide screens a paid, failed or expired state lines up
  with the left half (picture on the brand row, heading on the amount line).

### Added

- **Favicon on public pages**: `/pay`, `/return` and the public error pages
  use the payee's logo, else the company logo, else the Bogts logo (always the
  Bogts logo, with an amber dot, in sandbox).

## [0.1.0] - 2026-09-26

The first release: one Cloudflare Worker for Bonum and QPay.

### Added

- **Redesign**: a coin-pouch identity (Geologica and Piazzolla, self-hosted
  under `static/fonts`, OFL) for the dashboard and the payment pages, with
  light and dark themes.
- **Branding**: Settings → Branding sets the company name, logo (PNG, SVG or
  WebP, up to 256 KB), accent colour and support contacts; each project can
  override the display name and logo on its payment pages. SVG logos are
  rebuilt from an allowlist; files with scripts or embedded images are
  refused. **Apply migration `0007_branding` before deploying.**
- **QPay bank logos**: the hosted `/pay` page shows each bank app's logo (from
  QPay's `qpay.mn` hosts only), with the bank's initial as a fallback.
- **Bank grid**: a 3×3 grid of eight bank apps (Social Pay, Khan Bank, M Bank,
  TDB, Xac Bank, Capitron Bank, Monpay, State Bank 3.0, then QPay's order for
  any that are missing) and a "More" tile for the rest, with one-line,
  title-cased names.
- **Public pages in 6 languages**: `/pay`, `/return` and the public error
  pages speak Mongolian (the default), English, French, Russian, Simplified
  Chinese and Spanish, picked by `?lang=`, a cookie, country or
  `Accept-Language`.
- **Performance**: each dashboard page loads in one or two D1 round trips, and
  migration `0006_perf_indexes` replaces 13 indexes with ones matched to the
  queries (see `docs/performance.md`). Apply migrations before deploying.
- **Bonum failure reasons**: failed payments record Bonum's status and the
  bank response code (e.g. `51` insufficient funds) in the timeline; Bonum's
  free-text message is never stored.

- **Gateway** (`apps/gateway`): one deployment per company, many projects,
  each with its own API key, webhook URL, signing secret and plans.
- **QPay invoices**: a QR, bank-app deeplinks and a hosted page at `/pay/:id`.
  Callbacks are treated as hints and re-checked with `payment/check`, and an
  expiry sweep checks each invoice exactly once.
- **Bonum**: card subscriptions (renewals keyed on `invoiceId`, `UNSUBSCRIBED`
  handled, cancel with `planId`), card replacement, the hosted All-in-one
  invoice, saved-card charges (immediate or queued) and reversals.
  `x-checksum-v2` is verified with number text kept exactly as sent.
- **Project API** `/v1`: invoices, subscriptions, charges and events, with
  `Idempotency-Key` on every POST and cursor pagination.
- **Events**: an outbox with signed webhooks (`Bogts-Signature`), retries with
  backoff for 3 days, re-delivery, and the `GET /v1/events?after=` feed for
  reconciling.
- **Dashboard** at `/admin`, behind Cloudflare Access or a password. It fails
  closed when neither is configured.
- **`@gege-mn/bogts`**: a typed client, `verifyWebhook` and `constructEvent`.
  ESM only; Node ≥ 20, Workers, Deno and Bun.
- **Deploy to Cloudflare** button, D1 migrations applied on every deploy, and
  documentation: self-hosting, API, webhooks, providers.

### Hardening (real-world failure modes)

- **One purchase, one invoice**: `POST /v1/invoices` returns the pending,
  unexpired invoice for an identical request (same `reference`, `provider`,
  `amount`, `description`, `returnUrl` and `metadata`) (`200`) instead of
  creating another (`201`), unless `reuse: false`. A reference should identify
  exactly one purchase; a shared reference with different contents is a
  different purchase. The `Bogts-Reused: true|false` response header says
  which, and `@gege-mn/bogts` returns it as `reused` from `invoices.create`.
- **Other invoices closed once one is paid**: the purchase's other pending
  invoices are cancelled (no event) in the background; a QPay one only once
  QPay confirms the cancel, else it stays pending for its expiry check.
- **Paid twice**: a second invoice paid for the same purchase is still
  settled; its `invoice.paid` carries `duplicateOfInvoiceId`, and Overview's
  "Needs attention" says "N references paid twice: refund one". When one
  QPay invoice's QR is paid twice, the invoice is settled once and the extra
  payment is listed on "Needs attention" to refund (`qpay.extra_payment`, not
  `duplicateOfInvoiceId`); a QPay payment later shown as refunded is recorded
  and listed too.
- **QPay late check**: an expired or cancelled QPay invoice is checked once
  more about 24 h after expiry, since QPay keeps accepting payment and its
  callback can be lost. `invoice.paid` then follows `invoice.expired` (or the
  cancel).
- **Bonum invoice grace**: a Bonum hosted invoice expires 2 h after
  `expiresAt`, so Bonum's webhook retries can land first.
- **Missed Bonum renewals are reconciled** hourly with Bonum's Get
  Subscriptions: credited (`subscription.renewed`), cancelled
  (`reason: "provider_cancelled"`) or marked past due
  (`subscription.payment_failed`, `reason: "renewal_missing"`). Renewals are
  deduplicated by billing period, so a reconciled renewal and its late
  webhook never both count.
- **Bonum failure codes on the timeline**: a failed invoice, checkout, card
  change, renewal or queued charge records Bonum's status, bank response code
  (with a short meaning, e.g. `bank code 51 (insufficient funds)`) and payment
  vendor. Bonum's free-text `message` is still never stored.
- **Docs**: correcting events, granting by `reference` idempotently, and the
  reconciliation behaviour (`docs/webhooks.md`).

### Fixed

- Bonum's sandbox refuses `items[]` without `remark` (and, for tokenization,
  `image`); both are now always sent.
- A checkout Bonum refuses now emits `subscription.payment_failed`
  (`checkout_failed`), as a failed invoice emits `invoice.failed`.
- The dashboard's event page shows exactly the delivered body.
- Bonum timestamps with an explicit zone are read with it (zone-less ones
  stay Ulaanbaatar time, now proven from Bonum's own samples).

### Not yet

- e-barimt (the columns are reserved).
