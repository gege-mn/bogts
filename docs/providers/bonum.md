# Bonum in Bogts

How Bogts uses [Bonum](https://bonum.mn)'s merchant API, and what it does about
the places where a direct integration usually goes wrong. The API itself is in
[bonum-api.md](bonum-api.md), taken from Bonum's Postman collection. The
places where a Bonum integration usually goes wrong, and how Bogts avoids each,
are in [bonum-pitfalls.md](bonum-pitfalls.md).

## Setup

See [self-hosting → Bonum setup](../self-hosting.md#bonum-setup). In short:

- set `BONUM_APP_SECRET`, `BONUM_TERMINAL_ID` and `BONUM_CHECKSUM_KEY`, and
  `BONUM_ENVIRONMENT=test` for the sandbox;
- register `${PUBLIC_ORIGIN}/hooks/bonum` as the webhook URL in Bonum's portal;
- create plans in Bonum's portal, then map them to plan keys in `/admin`.

| Environment | Host |
|---|---|
| `production` | `https://apis.bonum.mn` |
| `test` | `https://testapi.bonum.mn` |

## What Bogts calls

| Bogts feature | Bonum API |
|---|---|
| Access token | `auth/create`, then `auth/refresh`. The token is cached in memory, then in D1 (encrypted), and shared by every isolate. `auth/create` is rate limited, so it is called only when there is no usable token. |
| Hosted invoice (`POST /v1/invoices`, `provider: "bonum"`) | Create Invoice (All-in-one): Bonum's checkout page with QPay, card, WeChat and SonoShop. The result arrives as a `PAYMENT` webhook. |
| Subscription (`POST /v1/subscriptions`) | Create Card Token with a subscription (`payNow: true`), after checking the plan against List Of Payment Plans. The customer enters the card on Bonum's page. |
| Card replacement (`POST /v1/subscriptions/:id/card`) | Change Subscription Token (Create New Token) |
| Saved card (`POST /v1/cards`, `POST /v1/cards/:id/replace`) | Create Card Token with **no** `subscription`: a plain card token that Bonum never charges on its own. With a first payment, `payment.amount` is sent; without one, Bonum takes its 0.01 MNT card check. |
| Card removal (`DELETE /v1/cards/:id`) | Nothing: the collection documents no call that deletes a plain card token. Bogts deletes its copy of the token, which is the only one that can charge. |
| Cancel (`DELETE /v1/subscriptions/:id`) | Delete Subscription (`/delete`) **with `planId`**. Plain unsubscribe would still take the next payment. |
| Charge (`POST /v1/charges`) | Purchase with the card token, of a saved card or of a subscription's card. The answer can be immediate or queued; a queued result arrives as a `TOKEN-PAYMENT` webhook. |
| Reverse (`POST /v1/charges/:id/reverse`) | Rollback Purchase |
| Plan check (dashboard) | List Of Payment Plans: amount, recurring type and status |
| Renewal reconciliation (hourly) | Get Subscriptions with the card's `X-CARD-TOKEN`: `lastBilledAt`, `nextBillAt`, `status` |

Bonum's test-only endpoints (Get Invoice Status, Set Invoice To Paid, Execute A
Subscription Payment) are never called in production. The expiry sweep marks
an unpaid Bonum invoice expired locally, because Bonum has no production
status endpoint, and only **2 hours after `expiresAt`**, so a `PAYMENT`
webhook Bonum is still retrying lands first. One that lands later still
settles the invoice.

**Time zone.** Bonum's timestamps (`completedAt`, `nextBillingDate`,
`lastBilledAt`, …) carry no zone and are Ulaanbaatar time (UTC+8). The docs
prove it: every response's `traceId` starts with the epoch seconds it was
minted at, and each sample's local time is that plus 8 hours (for example
`0x6976ca6c` = 01:59:08Z beside `subscribedAt: "2026-01-26 09:59:11"`).

## Webhooks

`POST /hooks/bonum`:

1. The body is capped at 64 KiB.
2. `x-checksum-v2` is checked before the body is parsed. It is an HMAC-SHA256
   under `BONUM_CHECKSUM_KEY`, and Bogts accepts it over the raw bytes, over the
   body with whitespace removed **keeping number text exactly as sent**
   (`10000.00` stays `10000.00`), or over the re-serialized JSON. A bad checksum
   gets `401`.
3. The message is applied through the ledger, in the same batch as the state
   change and exactly one event. A replay is a no-op.
4. The answer is `200 SUCCESS`, including for messages Bogts deliberately
   ignores. If anything fails while applying it, the answer is `503`, so Bonum
   retries. Every answer is JSON, `{"status":200,"message":"SUCCESS"}`: Bonum's
   sender parses the reply, and a bare `SUCCESS` fails there ("Unrecognized
   token 'SUCCESS'" in the merchant portal's webhook log).

| Bonum `type` | What Bogts does |
|---|---|
| `CARD-TOKEN` | Matched by its `transactionId`. For a subscription: activates it and records the first charge (`subscription.active`), or completes a card replacement (`subscription.card_changed`). For a saved card: saves it (`card.saved` or `card.replaced`) and records a first payment as a charge (`charge.succeeded`), at the amount asked for when the message doesn't report one. The 0.01 MNT card check is not counted as money. |
| `SUBSCRIPTION-PAYMENT` | A renewal (`subscription.renewed`) or a failed renewal (`subscription.payment_failed`). **Keyed on `invoiceId`**, never on `transactionId`, which is the same on every renewal, and also on the **billing period** the charge pays for, so a renewal already credited by reconciliation is not credited again. A success that falls well before the known `nextBillAt` is the first charge echoed back, and it is not credited twice. A failure for a period already paid is ignored. |
| `UNSUBSCRIBED` | Bonum's retries ran out and it ended the mandate. The subscription is cancelled with `reason: "retries_exhausted"`, the card token is dropped, and the customer can subscribe again. |
| `PAYMENT` | A hosted invoice was paid, failed or expired. |
| `TOKEN-PAYMENT` | The result of a queued charge (`charge.succeeded` or `charge.failed`). |

Bogts never shows or relies on Bonum's `message` text or purchase `errorCode`
strings; Bonum's docs advise against both. Events carry short machine codes
instead.

## When a renewal webhook never arrives

A lost `SUBSCRIPTION-PAYMENT` means the customer is charged but the project
never hears of it. Every hour (minute 5), each `active` or `past_due`
subscription whose `nextBillAt` is more than 6 hours past is looked up with Get
Subscriptions (at most 50 per run):

| Bonum shows | Bogts does |
|---|---|
| billed since the last renewal Bogts credited (`lastBilledAt`) | credits the renewal: `subscription.renewed` |
| `CANCELLED` / `UNSUBSCRIBED` (or `CANCELED`, `DELETED`) | cancels it: `subscription.cancelled`, `reason: "provider_cancelled"` |
| `ACTIVE`, not billed | `past_due` once, with `subscription.payment_failed`, `reason: "renewal_missing"` |
| an error, no such subscription, another status | nothing; tries again next hour (noted at most once a day) |

**Never credited twice.** Each renewal's ledger row records the scheduled
billing date it pays for, worked out from the charge's own time (`completedAt`
or `lastBilledAt`) and the subscription's first billing date, and the ledger
allows one row per subscription and period. If reconciliation credited a
period first, the late webhook for it adopts that row instead of crediting; if
the webhook came first, reconciliation finds the period taken. A second real
charge in one period (a different Bonum `invoiceId`) is still credited, and
flagged on the timeline.

The Get Subscriptions answer is not documented beyond its headline; Bogts
reads the item shape of Subscribe's answer (`subscriptionId`, `lastBilledAt`,
`nextBillAt`, `status`) and skips anything it can't match. **Confirm the
shape and the cancelled status names on the sandbox.**

## Testing on the sandbox

Bonum's sandbox can trigger a subscription charge on demand
(`PUT /subscriptions/:id/execute`). That exercises renewal, failure and
`UNSUBSCRIBED` without waiting a month. Run a staging deployment with
`BONUM_ENVIRONMENT=test` and its own plans (sandbox plan ids differ from
production ones).

What the sandbox showed (smoke tests against staging, 2026-09-25):

- **`items[]` needs `remark`, and tokenization's needs `image` too**, although
  the docs call `items` optional. Create Invoice refused an item without
  `remark` and accepted `remark: ""`; Create Card Token needs both `image` and
  `remark` (empty strings are fine). Bogts always sends them.
- The test card **4111 1111 1111 1111**, expiry **12/30**, CVV **123** pays a
  hosted invoice by card.
- Card tokenization (subscriptions, card replacement) **cannot be completed in
  the sandbox** without a real card.
- `transactionId` must be unique per invoice: reusing one answers `409`. Bogts
  sends its own invoice id, which is always new.
- Get Invoice Status is disabled on the sandbox too.
- The shared test terminal **17171119** has Bonum's own webhook URL
  registered, so its webhooks never reach you. To test webhooks, ask Bonum for
  your own sandbox terminal and register `${PUBLIC_ORIGIN}/hooks/bonum` on it.

What a real card showed on production (2026-10-05 and 2026-10-06), for saved
cards with no plan:

- The `CARD-TOKEN` message of a tokenization with no `subscription` carries
  `token`, `mask`, `expiry`, `bank.name` and `transactionId`, as Bogts reads
  them.
- Purchase and Rollback Purchase work on such a token: a 500 MNT charge
  succeeded at once and was reversed.
- A first payment (`payment.amount`) **is taken, but was not reported** as the
  amount asked for in the `amounts[]` Bogts read. So a successful `CARD-TOKEN`
  for a card step that asked for a payment is recorded as that amount unless
  Bonum reports a different payable one, and the card's timeline says the
  amount was assumed, with the field names and amounts Bonum did send.
- Rollback Purchase **refused** that first payment (HTTP 400), using the
  tokenization's `transactionId`. `POST /v1/charges/:id/reverse` still tries
  it and answers `502 provider_error` when Bonum refuses. That test ran while
  Purchase was also failing on Bonum's side (HTTP 400, bank code 99), so it
  is worth one more try.

**Still to confirm on the sandbox:** whether a `payNow` tokenization also sends
a `SUBSCRIPTION-PAYMENT` for the first charge. Bogts guards against it either
way ([bonum-pitfalls.md](bonum-pitfalls.md#1-renewals-keyed-on-transactionid-are-dropped)).
