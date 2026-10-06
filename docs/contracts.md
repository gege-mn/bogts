# Build contracts (for contributors and agents)

Every module follows these rules. Change them only deliberately, and in this
file first.

## Stack
- pnpm workspace, Node ≥ 24, TypeScript 6, ESM.
- `apps/gateway`: SvelteKit 2 + Svelte 5 (runes), `@sveltejs/adapter-cloudflare`,
  Drizzle ORM on D1, zod 4 for input validation, vitest 4 + better-sqlite3 for
  tests (a real SQLite DB built from the migrations, never a mock DB, reached
  through the production `drizzle-orm/d1` driver over a small D1 fake).
- `packages/client`: `@gege-mn/bogts`, with no runtime dependencies; it
  works in Workers, Node and browsers (server side only: it carries an API key).
- Versions: svelte ^5.56, kit ^2.63, adapter-cloudflare ^7.2,
  vite ^8, vitest ^4.1, wrangler ^4.131, drizzle-orm ^0.45, drizzle-kit ^0.31,
  zod ^4.5, qpay-js 1.0.0, ulid ^3.

## Worker entry
The Worker's `main` is `apps/gateway/src/worker.ts`, written by hand. It
re-exports the adapter's `fetch` (alias `kit:worker` → `.svelte-kit/cloudflare/_worker.js`)
and adds `scheduled`. The adapter builds from `wrangler.build.jsonc`, because it
rewrites the `main` its config names.

**No Cloudflare Queues:** the Deploy button must work on the free plan.
- **Event delivery:** the first attempt runs inline via `ctx.waitUntil`. A cron
  runs every minute (`* * * * *`) and retries due deliveries with backoff.
- **Jobs on that one cron** (`cron.ts`): deliver every minute; sweep (which also
  ends abandoned card steps), then late_check, every 10 min (`minute % 10 === 0`); reconcile hourly at :05;
  purge hourly at :00.

## Layout (`apps/gateway/src/lib/server/`)
| Module | Owns |
|---|---|
| `env.ts` | `type Env`; `loadConfig(env)` validates configuration and fails closed. It reports which providers are enabled; a provider is enabled only when all of its secrets are present. |
| `db.ts`, `schema.ts` | Drizzle `getDb(d1)`, `type DB`; **the complete schema lives here** |
| `ids.ts` | `newId()` (ULID). The API key format is `bgk_<32 base62>`; the webhook secret format is `bgwh_<32 base62>`. |
| `crypto.ts` | `encrypt(plain, key)` / `decrypt(ct, key)`: AES-256-GCM, `v1.<iv>.<ct>` in base64. `sha256Hex`, `hmacSha256Hex`, `timingSafeEqual`. `ENCRYPTION_KEY` is 32 bytes, base64. |
| `money.ts` | Amounts are **integer MNT** at the API. `toMnt(providerAmount)` rounds provider decimals (`10000.00` → `10000`) and rejects fractions except the known 0.01 card-verification charge. |
| `auth/api-key.ts` | `authenticateProject(request, db)`: resolves `Authorization: Bearer bgk_…` by hash to a `project`, or throws a 401 `ApiError`. |
| `auth/admin.ts` | Admin gate: a Cloudflare Access JWT (`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`), or an `ADMIN_PASSWORD` session cookie (HMAC-signed, 12 h, `HttpOnly; Secure; SameSite=Strict`). If neither is configured, every `/admin` and `/v1` request gets a 503 "not configured". |
| `api/errors.ts` | `ApiError(status, code, message)`. The JSON error shape is `{ error: { code, message } }`. Messages are safe to show and never echo provider text. |
| `events/emit.ts` | `emitEvent(db, { projectId, type, data, subjectId })` inserts into `event` and creates a `delivery` row, and returns the event. Providers **only ever call this**; they never deliver. |
| `events/deliver.ts` | Signs and POSTs, with backoff, and marks results. It is run by `waitUntil` and by the cron. |
| `providers/bonum/*` | The HTTP client, token cache, checksum, and webhook handler |
| `providers/qpay/*` | The qpay-js wrapper, token cache, callback, and payment check |
| `services/invoices.ts`, `subscriptions.ts`, `charges.ts` | The provider-agnostic logic that routes call |
| `sweep.ts` | The expiry sweep (each invoice is checked once; see `docs/design.md`) |
| `usage.ts` | Monthly usage meter per project: counts and volume, derived from `ledger` |

Routes: `src/routes/v1/**` (project API), `src/routes/hooks/**` (provider
webhooks), `src/routes/admin/**` (dashboard), `src/routes/health/+server.ts`.

## Rules
- **Idempotency:** every provider payment is written through `ledger`, which
  has a UNIQUE `(provider, provider_ref)`. The ledger insert and the state
  change happen in one `db.batch`, and exactly one event is emitted for each
  ledger row. The project API accepts `Idempotency-Key` on POST: it is stored
  per project for 24 h, and a repeat request returns the first response.
- **Timestamps** are integer epoch-ms UTC. **Ids** are ULIDs. **Money** is
  integer MNT.
- **Never log** credentials, tokens, card tokens or full webhook bodies. Log
  only the event type and our own ids.
- **Webhooks from providers:** the body is capped at 64 KiB and verified before
  it is parsed. On an internal error, answer 503 so the provider retries.
- **Tests:** each module has a `*.test.ts` next to it. Providers are faked with
  `vi.stubGlobal('fetch', …)`. Webhook fixtures are copied from
  `docs/providers/bonum-api.md` exactly, decimals included.
- **Commits:** one per module, with a clear message. Don't push; the
  orchestrator pushes.

## As built (foundation, 2026-09-25)

Where the foundation refines or departs from the table above. Code against these.

- **Extra modules** in `lib/server/`: `rate-limit.ts` (D1 fixed windows),
  `audit.ts` (`recordAudit`), `activity.ts` (`recordActivity`, the per-subject
  timeline), `gate.ts` (path areas + security headers), `locals.ts`
  (`requireConfig`, `requireAdmin`), `cron.ts` (`runCron`, heartbeats),
  `testdb.ts` (test DB behind the D1 driver + fixtures).
- **`loadConfig`** throws `ConfigError` (variable names only) when: no
  `ENCRYPTION_KEY` or not 32 bytes; no admin auth; only one of the two Access
  vars; `ADMIN_PASSWORD` under 12 characters; a `*_ENVIRONMENT` other than
  `production`/`test`; a non-https `PUBLIC_ORIGIN` (http://localhost allowed).
  An empty `*_ENVIRONMENT` means **production**. A provider is on only with all
  three of its secrets **and** `PUBLIC_ORIGIN`; a partial set switches it off
  with a `warnings` entry instead of failing the deployment. When Access is
  configured the password is ignored. `/hooks` also answers 503 while
  unconfigured (so providers retry).
- **Admin session cookie** `bogts_admin`: stateless, `Path=/admin`, `Secure`
  except on `http://localhost`, signed with a key derived from `ENCRYPTION_KEY`
  and the password (changing either signs everyone out). No `admin_session`
  table. Login: 10 attempts per IP and 100 failed attempts overall per 15
  minutes; the overall limit never refuses the right password. (The per-IP
  key is the full IPv4 address or the IPv6 /64: `ip.ts`.)
- **`timingSafeEqual`** is async (`Promise<boolean>`), since it uses Web Crypto.
- **`toMnt(0.01)` returns 0** (the verification charge is not money);
  `isVerificationCharge()` tells it apart from a real 0.
- **Events:** `eventInserts(db, input, now)` returns the two insert statements
  so a caller puts them in the same `db.batch` as its ledger row and state
  change; `emitEvent` is the stand-alone form. Optional `dedupeKey` (unique).
  Every event gets a `delivery` row even when the project has no webhook URL;
  the deliverer settles those (`last_error = 'no_webhook_url'`). A new delivery's
  `next_attempt_at` is `now + 60 s`, so the inline attempt rarely races the cron.
- **`deliverDue(db, config, now)`** and **`sweepExpired(db, config, now)`**
  return a count and never reject. **`expireCardSteps(db, config, now)`**
  (`services/cards.ts`, run in the `sweep` job after `sweepExpired`) ends up
  to `CARD_STEP_BATCH` card steps still `pending` `CARD_STEP_TTL_MS` (24 h)
  after they were started: `failSetup` (`card.failed`, reason
  `checkout_failed`) and activity `card.step_expired`; a row that throws is
  logged and skipped. The cron runs deliver every minute; sweep
  and late_check every 10 min (`minute % 10 === 0`); reconcile hourly at :05;
  and a purge of idempotency keys and rate-limit windows hourly at :00,
  writing `cron_heartbeat` rows (`tick` + each job).
- **API keys** rotate with a 24 h overlap (`rotateApiKey`): the previous key's
  hash stays valid until `previous_api_key_expires_at`.
- **Every select inside `db.batch` must have unique column names.** D1's
  `batch()` returns rows as objects keyed by column name, and drizzle-orm's D1
  driver maps a batched row back by position over `Object.keys(row)`
  (`d1ToRawMapping` in `drizzle-orm/d1/session.js`, 0.45). Two result columns
  with the same name (`id`, `name`, `status`, `created_at` from joined tables)
  collapse into one key and every later field shifts (the payment page once
  showed the project's webhook URL as its name). Outside a batch Drizzle reads
  arrays (`raw()`), so the same select is fine there. The pattern: a batched
  select that joins tables or computes columns takes its fields through
  `batchSelect({...})` (`db.ts`), which aliases every column to its path
  (`invoice.id`, `project.name`) and keeps decoders (json, boolean). A
  LEFT-joined group is then not nulled when nothing matched: read it through
  `leftJoined(row.group, 'id')`, and type a left-joined flat field nullable by
  hand. Also never let a result column be named like an integer (`select 1`
  unaliased): JavaScript orders such keys first. Tests enforce this: the test
  DB (`testdb.ts`) runs the real D1 driver over better-sqlite3 and throws on a
  repeated or integer-like column name in any object result
  (`db.$d1.strictColumns`), and `routes/admin/(app)/loads.test.ts` runs every
  dashboard load against two differing projects.
- **The test D1** also refuses `BEGIN`/`SAVEPOINT` (D1 has no SQL
  transactions: use `db.batch`, never `db.transaction`), more than 100 bound
  parameters per statement, and binding `undefined`.
- **Idempotency:** a reused key with a different method/path/body → 422
  `idempotency_key_reused`; while the first request runs → 409
  `idempotency_in_progress` (a claim older than 60 s with no answer is taken
  over); an answered 5xx or a thrown 4xx releases the key; any other throw
  (a 5xx `ApiError`, an unexpected error: work may have half-happened) is
  stored and replayed. Replays carry `Idempotent-Replayed: true`.
- **Deploy button and the monorepo:** Cloudflare's docs say a Deploy button in
  a subdirectory needs the app "fully isolated within that subdirectory". So
  `apps/gateway` stands alone: its own `tsconfig.json` (no `../../` base),
  `.gitignore`, `LICENSE`/`NOTICE`, `packageManager` (pnpm 10.11.1, Workers
  Builds' default) and a standalone `pnpm-lock.yaml` derived from the root one
  by `pnpm lockfile:gateway` (CI checks it). **Nothing in `apps/gateway` may
  import from outside it**, except tests (`deliver.test.ts` cross-checks
  signatures against `packages/client`).

## As built (modules, 2026-09-25)

Where the qpay, events, bonum and admin modules refine the contracts above.

- **Services return JSON for subscriptions and charges, rows for invoices.**
  `createSubscription`/`getSubscription`/`listSubscriptions`/`cancelSubscription`/`replaceCard`
  and `createCharge`/`getCharge`/`listCharges`/`reverseCharge` return the public
  shapes (`SubscriptionJson`, `ChargeJson`, lists as `ListPage<…>`). The invoice
  services return `Invoice` rows (`listInvoices` → `{ data: Invoice[], hasMore,
  nextCursor }`); the route maps them with `invoiceJson(inv, config)`, since
  `payUrl` needs the config.
- **List filters:** `GET /v1/invoices` takes `?reference=` and `?status=`;
  `GET /v1/subscriptions` takes `?customerRef=` and `?status=`;
  `GET /v1/charges` takes `?subscriptionId=` and `?status=`. All take
  `?limit`/`?cursor`.
- **Events feed** (`events/feed.ts`): `GET /v1/events` is newest first with
  `?cursor=`, or oldest first with `?after=<event id>` (an empty `after=`
  starts at the beginning; the reconciliation feed). `?cursor` and `?after`
  together are a 400. `?type=invoice.paid,charge.failed` filters by type
  (comma separated, known types only). Events minted less than 5 s ago are held
  back from the list (`FEED_STABILITY_MS`), since ULIDs from different isolates
  can commit out of order; `GET /v1/events/:id` has no cutoff.
- **QPay** (`providers/qpay/*`): `qpay-js` pinned to exactly 1.0.0; tokens are
  shared across isolates through D1 `provider_token` (encrypted). `payment/check`
  is the only proof of payment (status `PAID` and the exact amount; a different
  amount is recorded as activity, not settled). The callback
  `/hooks/qpay/:invoiceId` never reads the body, re-checks at most 20 times per
  invoice per 10 min, and answers 503 when it could not find out.
- **Public pages:** `/pay/:invoiceId` (hosted QPay page) and
  `/return/:invoiceId` (after Bonum's hosted invoice) show only
  `public/invoice-view.ts` fields; the only redirect target is the invoice's
  `returnUrl` through `safeReturnUrl()` (http/https only). `GET /pay/:id/status`
  answers `{ status, paidAt, returnUrl }` (the same `safeReturnUrl()`), is
  limited to 240 requests per minute per client (the full IPv4 address or the
  IPv6 /64, `ip.ts`), and asks QPay at most once per 10 s per invoice while
  pending. `GET /return/s/:subscriptionId` 303s to the subscription's
  `returnUrl` with `?subscription=<id>` added; state only ever comes from
  webhooks.
- **Bonum** (`providers/bonum/*`): the checksum accepts the raw body, the
  whitespace-compacted body (decimals kept) and re-serialized JSON. Renewals
  are ledgered as `sub-invoice:<invoiceId>`, never the tokenization
  `transactionId`. Bonum invoices have no `check()` or `cancel()` (the status
  API is test-only), so the sweep expires them locally (after a 2 h grace, see
  "As built (hardening)"). Subscriptions store
  `billing_anchor` (the first billing date): monthly and yearly periods keep its
  day of month, clamped, so they never drift.
- **Plan validation** (`providers/bonum/plans.ts` → `validatePlan`) runs before
  every checkout (409 `plan_mismatch`). The dashboard records every check as a
  `plan.validate` audit row (`detail.result` = `ok`/`mismatch`/`error`); a plan's
  status is the newest such row at or after its last edit, so there is no
  status column.
- **Admin** (`lib/server/admin/*`): one module per page (`overview`,
  `invoices`, `subscriptions`, `charges`, `cards`, `events`, `projects`, `usage`,
  `search`, `health`), `actions.ts` for form-action plumbing (`adminOnly`,
  `adminContext`, `failFrom`), `common.ts` for paging and delivery roll-ups.
  Dates on the dashboard are Ulaanbaatar time (UTC+8, no DST): Overview's KPIs
  and chart use the same UB calendar days, and Usage months are UB months. The
  events list's `?status=failing` (retrying or failed, created in the last 7
  days) is what the sidebar badge and Overview's "deliveries failing" count.
  The per-IP login limit keys on the full IPv4 address or the IPv6 /64.
- **Idempotency** (unchanged, restated): a thrown 4xx releases the key, and so
  does an answered 5xx response; a thrown 5xx `ApiError` or an unexpected error
  is stored and replayed, because the work may have half-happened.

## As built (hardening, 2026-09-26)

Real-world failure modes: several invoices for one purchase, a callback that
is only a hint, notifications that never arrive. Code against these.

- **Same purchase** (`services/purchase.ts` `samePurchase`, the one test used
  by reuse, sibling cancel and the paid-twice flag): project, `reference`,
  `provider`, `amount`, `description`, `returnUrl` and `metadata` ALL equal
  (metadata as canonical JSON, sorted keys, null equal to `{}`).
  `purchaseWhere` narrows the query; rows must still pass `samePurchase`. A
  shared reference with different contents is a different purchase: not
  reused, not cancelled, not flagged. A reference should identify exactly one
  purchase (an order id).
- **Invoice reuse** (`services/invoices.ts` `openInvoice`): unless the body
  says `reuse: false`, `POST /v1/invoices` returns the project's newest
  `pending` invoice for the same purchase that has a provider id and at least `REUSE_MIN_REMAINING_MS` (60 s) before
  `expiresAt`, with **200** instead of 201. It is returned unchanged. Not
  atomic: two racing requests can both create one (Idempotency-Key is the
  strict guard; the rules below cover the rest).
- **Siblings are closed** (`services/settle.ts`): after a settlement commits,
  the other `pending` invoices of the same purchase are cancelled by
  `cancelSiblings`. A provider with `cancel` (QPay) is asked first, and only
  when it confirms is the row updated (conditional, to `cancelled`; **no
  event**, like a project's own cancel; `invoice.superseded` activity). If
  QPay refuses or errors, the invoice stays `pending`
  (`invoice.provider_cancel_failed` activity), so the at-expiry sweep still
  checks it. Bonum has no cancel: cancelled locally. It runs in
  `ctx.waitUntil` when there is one, else inline after the commit, and never
  rejects, so it can't fail a settlement. Money reaching a cancelled invoice
  is still settled.
- **Paid twice**: `settleInvoice` looks for the first-paid other invoice of
  the same purchase; the `invoice.paid` data then carries
  `duplicateOfInvoiceId` (optional field of `InvoiceEventData`, mirrored in
  `@gege-mn/bogts`). After the commit it records `invoice.duplicate_payment`
  (also when two settle at the same instant and the field was missed).
  Overview's "Needs attention" shows "N references paid twice: refund one"
  (activity from the last 30 days, `PAID_TWICE_WINDOW_MS`), linking to
  `/admin/payments?reference=…&project=…` (the payments list now filters by
  exact `reference`).
- **Needs attention, from activity** (`admin/overview.ts` `ACTIVITY_FLAGS`,
  same 30-day window): one line per kind with a count of subjects, linking to
  the newest: `qpay.payment_refunded`; `bonum.subscription_payment.same_period`;
  `reconcile.period_conflict` + `reconcile.period_unknown` (the held ones);
  `reconcile.renewal_missing`; `reconcile.no_card`;
  `reconcile.provider_cancelled`.
- **QPay callback**: nothing from the request is read (body, query such as
  `?qpay_payment_id=`, headers); `processQpayCallback(ctx, invoiceId)` never
  sees it. Settlement only from a `payment/check` row with `PAID` and the exact
  amount. For an invoice already `paid`, the callback re-checks at most
  `PAID_RECHECKS_PER_WINDOW` (3) times per `PAID_RECHECK_WINDOW_MS` (10 min);
  the callback that settles the invoice uses none of them.
- **QPay check findings** (`providers/qpay/invoice.ts` `reviewPayments`), each
  recorded once per distinct text: more than one `PAID` row → the first
  matching row is settled once, the others are `qpay.extra_payment` (ids and
  amounts; on "Needs attention"); QPay returns the settled payment's row with
  a status other than `PAID` (e.g. REFUNDED) → `qpay.payment_refunded`, the
  invoice stays `paid` (a missing row or an empty answer records nothing).
  Every note inside `check` is best effort: a D1 failure writing it never
  makes `check` throw or changes its answer.
- **QPay late check** (`sweep.ts` `lateCheckExpired`, cron every 10 min after
  the sweep, job `late_check`): QPay invoices that ended `expired` or
  `cancelled` (by the project or as a sibling), with `expiresAt` between 7
  days and 24 h ago (`LATE_CHECK_AFTER_MS`,
  `LATE_CHECK_MAX_AGE_MS`), are claimed through `invoice.late_checked_at`
  (conditional update, at most 100 per run) and checked once more. Paid →
  `settleInvoice` (`invoice.paid` after `invoice.expired` or the silent
  cancel). A QPay error still
  uses up the check (`late_check.failed`). The at-expiry sweep is unchanged.
- **Bonum invoice grace**: the sweep selects a provider without `check`
  (Bonum) only at `expiresAt + BONUM_EXPIRY_GRACE_MS` (2 h). Until then it
  stays `pending` (the public pages already show it as expired); a `PAYMENT`
  webhook after the grace still settles.
- **Bonum time**: `bonumTime` reads zone-less Bonum timestamps as Ulaanbaatar
  time (UTC+8). Evidence: every sample `traceId` begins with the epoch seconds
  it was minted, and the sample's local time is that plus 8 h. A string with
  an explicit zone is read with it.
- **Renewal reconciliation** (`reconcile.ts`, cron at minute 5, job
  `reconcile`): `active`/`past_due` subscriptions with a Bonum id whose
  `nextBillAt` is over 6 h past, claimed through `subscription.reconciled_at`
  (at most 50 per run, least recently asked first, re-claimable after 55 min).
  Bonum `GET /mpay-service/merchant/subscriptions` with `X-CARD-TOKEN`,
  matched by `subscriptionId`. Billed = ALL of: its `lastBilledAt` newer
  than our newest ledger credit for the subscription; not the activation
  charge (`lastBilledAt` within 24 h of activation, the first charge's ledger
  row or else `currentPeriodStart`, AND over 12 h before our due date: the
  webhook's initial-echo rule, since Bonum may set the first billing date the
  next day); Bonum's `nextBillAt` more than `NEXT_BILL_MOVED_MARGIN_MS` (2 days)
  past our due date (a successful charge moves the schedule, a declined
  attempt doesn't). Billed → credit as below; a new charge with no
  `nextBillAt` → skipped (`reconcile.schedule_unknown`). Billed but not
  creditable (`reconcile.period_unknown`: fits no period;
  `reconcile.period_conflict`: the period is already credited) → held:
  `reconciled_at` is set to `now + RECONCILE_HOLD_MS (24 h) - 55 min`, so it
  is rechecked daily, noted once a day, and shown on "Needs attention". Status
  `CANCELLED`/`CANCELED`/`UNSUBSCRIBED`/`DELETED` → `endMandate` with reason
  `provider_cancelled`; `ACTIVE` and not billed → `past_due` once per period
  with `subscription.payment_failed` reason `renewal_missing` (dedupe key per
  due date). Errors, a missing entry, an unknown status or no card token →
  skipped, retried next run, activity at most once a day per kind.
  `bonumTime` reads a date-only value (`2026-02-02`) as 00:00 Ulaanbaatar.
- **Renewal dedupe by billing period** (the binding part): every renewal
  ledger row carries `period_key`, the ISO scheduled billing date it pays for
  (`providers/bonum/util.ts` `billingPeriodKey`): the latest date of the
  anchor schedule (`billing_anchor`, day of month kept) at or before the
  charge time + 12 h. It is computed from the **charge's own time** (webhook
  `completedAt`, Bonum `lastBilledAt`), never from current state, so both
  paths agree. `ledger` has UNIQUE `(subject_id, period_key)` (NULLs repeat, so
  other rows are unaffected). Reconciliation writes
  `sub-period:<subscriptionId>:<periodKey>`; a webhook keeps
  `sub-invoice:<invoiceId>`. Webhook finds a `sub-period:` holder → it adopts
  it (conditional rename to its `sub-invoice:` ref, no credit, no event;
  `bonum.subscription_payment.reconciled_earlier`). Reconciliation finds any
  holder, or loses the insert race → no credit. Webhook finds another
  `sub-invoice:` holder → a second real charge: credited with
  `period_key = <key>:<invoiceId>` and `bonum.subscription_payment.same_period`.
  A FAILED webhook whose attempt time maps to a credited period is ignored.
  A charge before the first scheduled date has no key (the `payNow` charge).
- **A card step's first payment** (`cardSaved`): a SUCCESS `CARD-TOKEN` for a
  step with `payment_amount` set is recorded as a succeeded charge at the
  payable MNT amount Bonum reports, or, when it reports none (absent, only the
  0.01 MNT check, or unreadable), at `payment_amount`, with activity
  `bonum.card_token.amount_assumed`. `failSetup` emits `card.failed` only for
  the caller whose conditional update ended the step.
- **Cron**: deliver every minute; sweep (with card-step expiry) then late check when `minute % 10 ===
  0`; reconcile at minute 5; purge at minute 0. `cronStatus` reports
  `lateCheck` and `reconcile` too.
- **Checkout refused by Bonum** (`createSubscription`): the row ends `failed`
  with `subscription.payment_failed` (`checkout_failed`), dedupe key
  `subscription.checkout_failed:<id>:<tokenizeTransactionId>`, the same a
  failed CARD-TOKEN would use, so once.
- **Bonum `items[]`**: always `remark: ''` (invoices) and `image: ''` +
  `remark: ''` (tokenization), via `bonumItem`: the sandbox refuses items
  without them although the docs call them optional.

## Public API shapes (binding for routes, the client package and the docs)
- **Timestamps** in API JSON are ISO-8601 UTC strings. D1 keeps epoch-ms internally.
- **Amounts** are integers in MNT, and `currency` is always `"MNT"`.
- **Lists** return `{ object: 'list', data: T[], hasMore: boolean, nextCursor: string | null }` and take `?limit` (1–100, default 20) and `?cursor`.
- **Errors** use `{ error: { code, message } }`. Codes are snake_case, and these are all the code emits: `invalid_request` (400), `invalid_json` (400), `provider_disabled` (400), `unauthorized` (401), `not_found` (404), `conflict` (409), `plan_mismatch` (409), `idempotency_in_progress` (409), `payload_too_large` (413), `idempotency_key_reused` (422), `rate_limited` (429), `internal_error` (500), `provider_error` (502), `not_configured` (503). `ErrorCode` in `api/errors.ts` is the list; add a code there and here together.

The object shapes:
- **Invoice:** `{ id, object: 'invoice', provider: 'qpay'|'bonum', status, amount, currency, reference, description, payUrl, redirectUrl, qr: { text, image } | null, deeplinks: Deeplink[], returnUrl, expiresAt, paidAt, metadata, items, createdAt }`
  - `payUrl` is our hosted page `${PUBLIC_ORIGIN}/pay/:id`, for QPay, or Bonum's `redirectUrl` for Bonum.
- **Subscription:** `{ id, object: 'subscription', plan: '<key>', customerRef, email, status, redirectUrl, card: { mask, expiry, bank } | null, currentPeriod: { start, end } | null, nextBillAt, cancelledAt, createdAt }`
  - `redirectUrl` is non-null only while the subscription is `pending`, or while a card replacement is pending.
- **Card:** `{ id, object: 'card', customerRef, status: 'pending'|'failed'|'active'|'removed', redirectUrl, mask, expiry, bank, createdAt }`
  - `pending` and `failed` come from the `card_setup` row, `active` and `removed` from the `card` row with the same id. `redirectUrl` is non-null only while `pending`.
- **Charge:** `{ id, object: 'charge', status, amount, currency, reference, cardId, subscriptionId, items, failureCode, createdAt }`
- **Line item:** `{ label, amount, quantity }`; `amount` is per unit and negative for a discount. An object's `items` is `null` when it was created with a plain `amount`.
- **Event:** `{ id, object: 'event', type, createdAt, data }`

The request bodies:
- `POST /v1/invoices`: `{ provider, amount | items, reference, description, returnUrl?, expiresIn? (seconds, 60–86400, default 1800), metadata?, reuse? (default true) }` → 201 new, or 200 with the reused pending invoice; response header `Bogts-Reused: true|false` (also on idempotent replays). `@gege-mn/bogts` `invoices.create` returns `Invoice & { reused: boolean }` (`CreatedInvoice`; from the status when the header is absent)
- `POST /v1/subscriptions`: `{ plan, customerRef, email?, returnUrl }`
- `POST /v1/charges`: `{ cardId | subscriptionId, amount | items, reference }` (charges that card, or the subscription's card)
- `POST /v1/cards`: `{ customerRef, returnUrl, payment?: { amount | items, reference } }`; `POST /v1/cards/:id/replace`: `{ returnUrl }`
- `POST /v1/invoices/:id/cancel`, `DELETE /v1/subscriptions/:id` and `DELETE /v1/cards/:id` take no body.
- Every POST accepts an `Idempotency-Key` header.

## Service signatures shared across modules (binding)
- `services/invoices.ts`
  - `openInvoice(ctx, project, input)` → `{ invoice, reused }` (the route answers 200 when reused), `getInvoice(ctx, projectId, id)`, `listInvoices(ctx, projectId, q)`, `cancelInvoice(ctx, projectId, id)`
  - `invoiceJson(inv, config)`
  - the registry `invoiceAdapters: Record<Provider, InvoiceAdapter>`
- `providers/bonum/invoice.ts`: `export const bonumInvoiceAdapter: InvoiceAdapter`
- `providers/qpay/invoice.ts`: `export const qpayInvoiceAdapter: InvoiceAdapter`
- `services/subscriptions.ts`
  - `createSubscription(ctx, project, input)`, `getSubscription(ctx, projectId, id)`, `listSubscriptions(ctx, projectId, q)`
  - `cancelSubscription(ctx, projectId, id, actor?)`, `replaceCard(ctx, projectId, id)`, `subscriptionJson(sub, plan, card)`
- `services/charges.ts`
  - `createCharge(ctx, project, input)`, `getCharge(ctx, projectId, id)`, `listCharges(ctx, projectId, q)`
  - `reverseCharge(ctx, projectId, id, actor?)`, `chargeJson(c)`
  - `chargeCard(ctx, { card, subscriptionId, amount, items, reference })` → the `Charge` row: one purchase of an active card, with every outcome handled. `createCharge` calls it.
- `services/cards.ts`
  - `createCard(ctx, project, input)`, `getCard(ctx, projectId, id)`, `listCards(ctx, projectId, q)`
  - `replaceSavedCard(ctx, projectId, id, input)`, `removeCard(ctx, projectId, id, actor?)`, `cardJson(c)`
  - `saveCard(ctx, setup, details)` and `failSetup(ctx, setup)`: called by the CARD-TOKEN webhook
- `services/items.ts`: `priceFields` (the `amount` and `items` request fields), `priceOf({ amount?, items? })` → `{ amount, items }`
- `providers/bonum/plans.ts`: `validatePlan(ctx, plan): Promise<{ ok: boolean; problems: string[]; remote: { name, amount, recurringType, status } | null }>`
- `events/deliver.ts`
  - `deliverDue(db, config, now)`, `deliverFresh(ctx)` (hooks.server.ts runs it via waitUntil after every /v1 and /hooks request)
  - `redeliver(ctx, eventId)`, `signPayload(secret, timestamp, body)`
- `sweep.ts`: `sweepExpired(db, config, now)`, `lateCheckExpired(db, config, now)`
- `reconcile.ts`: `reconcileRenewals(db, config, now)`
- `services/settle.ts`: `settleInvoice(ctx, inv, payment)`, `endInvoice(ctx, inv, status)`, `cancelSiblings(ctx, paidInvoice)`

Here `ctx` is the `ServiceContext` from `services/context.ts`.

## As built (Bonum failure reasons)
- A failed Bonum payment's activity summary carries only allowlisted machine
  fields: the status tokens (`status`, `invoiceStatus`, `cardStatus`), the
  bank response code `respCode` (digits, at most 3, with a short ISO 8583 meaning
  when known), and `paymentVendor` (shown only when it's `E_COMMERCE` or
  `QPAY`). Bonum's free-text `message` is never read. The code is in
  `providers/bonum/failure.ts`, and event payloads are unchanged.

## As built (branding and i18n)

**Tables** (migration `0007_branding`):

| Table / column | Purpose |
| --- | --- |
| `branding` (one row, `id = 'default'`) | `company_name`, `logo_hash`, `accent_color` (`#rrggbb`), `support_email`, `support_url` (https only), `updated_at` |
| `brand_logo` | Content-addressed logos: `hash` (sha-256 of the stored bytes, after SVG sanitising), `content_type` (`image/png`, `image/webp`, `image/svg+xml`), `data` (base64), `size`, `created_at` |
| `project.display_name`, `project.logo_hash` | A project's own name and logo on its payment pages |

The payee on a public page is the project's display name and logo, else the
company's, else the project name. The support email must be a plain address
(no `?`, `&`, `%` or spaces); the `mailto:` link is built only from one.

**Logos** (`lib/server/branding.ts`): the type is sniffed from the bytes
(never the upload's claim); 256 KB at most. Both save actions validate every
field before `storeLogo`, then drop the replaced logo if unused and sweep
`brand_logo` rows nothing references (older than 10 minutes, so a concurrent
save's fresh upload survives).

**`GET /brand/logo/[hash]`**: the stored bytes, `cache-control: public,
max-age=31536000, immutable`, the hash as a strong ETag (304 on
`If-None-Match`), `cross-origin-resource-policy: same-origin`, and
`content-security-policy: default-src 'none'; style-src 'unsafe-inline';
sandbox`. 404 (no-store) for an unknown or malformed hash.

**SVG sanitiser** (`lib/server/svg.ts`): tokenise, then re-serialise only
allowlisted content (single pass, safe by construction).

- Skipped: XML declaration, processing instructions, DOCTYPE (with its
  internal subset; entities are never expanded), comments, CDATA outside
  `<style>`.
- Elements: `svg g path circle ellipse rect line polyline polygon text tspan
  defs linearGradient radialGradient stop clipPath mask use title desc`.
  `<a>` and `<switch>` are unwrapped; anything else is dropped with its
  content. `<use>` without a `#id` href is dropped.
- Refused (400, "This SVG embeds images or scripts; export it as plain vector
  or upload a PNG"): `script`, `image`, `feImage`, `iframe`, `embed`,
  `object`, `video`, `audio`, `canvas`, `handler`, `listener`, anywhere. A
  document with nothing drawable left is refused too.
- Attributes: presentation (`fill`, `stroke`, `stroke-*`, `opacity`,
  `fill-opacity`, `fill-rule`, `clip-rule`, `clip-path`/`mask` as `url(#id)`
  or `none`, `stop-color`, `stop-opacity`, font and text-anchor properties)
  and geometry (`d`, `points`, `x`…`y2`, `cx`, `cy`, `r`, `rx`, `ry`, `width`,
  `height`, `viewBox`, `transform`, `offset`, gradient attributes,
  `preserveAspectRatio`, `version`), plus `id` and `class`. `href`/`src` under
  any prefix only as a same-document `#id` (written as `href`). The root gets
  the canonical `xmlns` (and `xmlns:xlink` if it had one).
- Values: numeric and the five XML entities are decoded first; a value
  survives only in a small character set (no `:`, `\`, `;`, `@`, `*`, `<`,
  `&`) with known functions only (`url` to a `#id`, colour and transform
  functions).
- `<style>`: simple class rules (`.a, .b { … }`) and the `style` attribute
  become presentation attributes (attribute < class rule in source order <
  inline style); quoted `url('#g')` / `url("#g")` are kept. At-rules and
  other selectors are ignored, and the element is dropped.

**Language** (`lib/i18n/public`): `/pay`, `/return` and the public error
pages speak `mn` (default), `en`, `fr`, `ru`, `zh-Hans`, `es`; the dashboard is
English. Order: `?lang=`, the `bogts_lang` cookie, `request.cf.country` = `MN`,
the best `Accept-Language` match, English for a Traditional Chinese reader
(`zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`), then Mongolian. A `?lang=` choice sets
`bogts_lang` (Path=/, one year, HttpOnly, SameSite=Lax, Secure on https) only
on HTML responses of the public area, never on `/brand/logo`, assets, JSON,
`/v1` or `/hooks`. `<html lang>` follows the locale. A 404 under `/pay/` or
`/return/` says "payment not found"; any other URL, "page not found".

**Fonts**: `static/fonts/<name>.<first 8 hex of sha-256>.woff2`, cached for a
year as immutable (`_headers`); `src/lib/fonts.test.ts` checks the names.
