# API reference

The project API lives at `https://<your host>/v1`. It speaks JSON over HTTPS.
Everything here is also available, typed, through
[`@gege-mn/bogts`](../packages/client/README.md).

- [Conventions](#conventions): auth, idempotency, errors, pagination, formats
- [Invoices](#invoices)
- [Subscriptions](#subscriptions)
- [Cards](#cards)
- [Charges](#charges)
- [Events](#events)
- [Other endpoints](#other-endpoints)

## Conventions

### Authentication

Every `/v1` request carries the project's API key:

```
Authorization: Bearer bgk_4pT0uQ2…
```

Keys are `bgk_` followed by 32 letters and digits. You get one when you create
a project in `/admin`, and it is shown only once. When you rotate a key, the
old one keeps working for 24 hours. A missing or unknown key gets `401
unauthorized`. Each project sees only its own objects: another project's id
answers `404`.

Keep the key on your server. It can create charges.

### Idempotency

Every `POST` accepts an `Idempotency-Key` header (1 to 255 printable ASCII
characters). Bogts stores the key per project for 24 hours:

| Case | Answer |
|---|---|
| The same key with the same method, path and body, after the first request finished | The first response, replayed, with `Idempotent-Replayed: true` |
| The same key with a different request | `422 idempotency_key_reused` |
| The same key while the first request is still running | `409 idempotency_in_progress` |
| The first request was refused with a 4xx error (such as `invalid_request` or `conflict`) | Nothing happened, so the key is released. Fix the request and send it again with the same key. |
| The first request failed with a 5xx error (such as `provider_error`) | The error is stored and replayed, because the work may have half-happened (a card charged, then the database failed). Look the object up (for example `GET /v1/invoices?reference=…`) before you try again with a new key. |

Use a key that comes from your own data (`order-42`, `renew-user_7-2026-10`),
so a retry after a timeout can't create a second invoice or charge.

### Errors

Every error has the same shape. The `message` is safe to show to a user, and
it never contains provider text or secrets.

```json
{ "error": { "code": "invalid_request", "message": "amount: Too small: expected number to be >=1" } }
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | A field is missing or invalid. The message names the first problem. |
| 400 | `invalid_json` | The body isn't JSON. |
| 400 | `provider_disabled` | That provider isn't configured on this gateway. |
| 401 | `unauthorized` | No API key, or an unknown one. |
| 404 | `not_found` | No such object in this project, or no such endpoint. |
| 409 | `conflict` | The object's state doesn't allow this, for example cancelling a paid invoice. |
| 409 | `plan_mismatch` | The plan no longer matches Bonum's. Checkouts for it are refused until it's fixed. |
| 409 | `idempotency_in_progress` | See [Idempotency](#idempotency). |
| 413 | `payload_too_large` | The body is over 64 KiB. |
| 422 | `idempotency_key_reused` | See [Idempotency](#idempotency). |
| 429 | `rate_limited` | Slow down. `Retry-After` says when to try again. |
| 502 | `provider_error` | Bonum or QPay failed or didn't answer. See [Idempotency](#idempotency) before retrying. |
| 503 | `not_configured` | The gateway is missing required configuration (see [self-hosting](self-hosting.md#configuration-reference)). |
| 500 | `internal_error` | A bug. Retry, and report it if it persists. |

Match on `code`, not on `message`.

### Pagination

List endpoints return newest first:

```json
{ "object": "list", "data": [ … ], "hasMore": true, "nextCursor": "01K5X9M3…" }
```

They take `?limit=` (1 to 100, default 20) and `?cursor=`. To get the next
page, pass the previous page's `nextCursor` as `cursor`. `nextCursor` is `null`
on the last page.

### Formats

- **Ids** are [ULIDs](https://github.com/ulid/spec): 26 characters that sort by
  creation time, such as `01K5X9M3QF2ZB7N8R4T6VWXY0C`.
- **Amounts** are integers in MNT (`49900` is ₮49,900). `currency` is always
  `"MNT"`.
- **Line items.** Wherever a request takes `amount`, it takes `items` in its
  place: lines `{ "label", "amount", "quantity" }` that Bogts adds up
  (`amount * quantity`, with `quantity` 1 when omitted). A discount is a line
  with a negative amount. Send `amount` or `items`, never both. There can be up
  to 50 lines, no line may be 0, and the total must be at least 1. The lines
  come back on the object and in its events as `items` (`null` for a plain
  amount). Bogts stores and reports them; it makes no pricing decisions.
- **Times** are ISO-8601 UTC strings, such as `2026-09-25T14:05:32.000Z`.
- Every response has `Cache-Control: no-store`.

## Invoices

A one-off payment. With `provider: "qpay"` Bogts creates a QPay invoice: a QR,
bank-app deeplinks and a hosted page. With `provider: "bonum"` it creates a
Bonum All-in-one checkout, where the payer picks QPay, a card, WeChat or
SonoShop on Bonum's page.

### The invoice object

```json
{
  "id": "01K5X9M3QF2ZB7N8R4T6VWXY0C",
  "object": "invoice",
  "provider": "qpay",
  "status": "pending",
  "amount": 49900,
  "currency": "MNT",
  "reference": "order-42",
  "description": "Order 42",
  "payUrl": "https://pay.example.com/pay/01K5X9M3QF2ZB7N8R4T6VWXY0C",
  "redirectUrl": null,
  "qr": { "text": "0002010102121531…", "image": "iVBORw0KGgoAAAANSUhEUgAA…" },
  "deeplinks": [
    { "name": "Khan bank", "description": "Хаан банк", "logo": "https://qpay.mn/q/logo/khanbank.png", "link": "khanbank://q?qPay_QRcode=0002010102…" }
  ],
  "returnUrl": "https://shop.example.com/orders/42",
  "expiresAt": "2026-09-25T14:35:32.000Z",
  "paidAt": null,
  "metadata": { "cart": "c_981" },
  "items": null,
  "createdAt": "2026-09-25T14:05:32.000Z"
}
```

| Field | |
|---|---|
| `status` | `pending`, `paid`, `expired`, `failed` or `cancelled`. Only `pending` can change, except that money arriving late still turns an `expired` or `cancelled` invoice into `paid`. When one invoice is paid, the project's other pending invoices for the same purchase (identical `reference`, `provider`, `amount`, `description`, `returnUrl`, `metadata` and `items`) become `cancelled` (with no event); a QPay one only once QPay confirms the cancel, else it stays `pending` until its expiry check. |
| `payUrl` | Where to send the payer. For QPay it is Bogts' hosted page `/pay/:id`, and for Bonum it is Bonum's checkout. |
| `redirectUrl` | Bonum's checkout URL, and `null` for QPay. |
| `qr` | QPay only. `text` is the QR payload and `image` is a base64 PNG (it may be `null`). |
| `deeplinks` | QPay only. One entry per bank app. |
| `returnUrl` | Where the payer is sent after paying. |
| `expiresAt` | After this, the expiry sweep (every 10 minutes) checks a QPay invoice once and settles it as `paid` or `expired`, and asks QPay once more about 24 hours later (also for a `cancelled` QPay invoice) in case a payment arrived with its callback lost. A Bonum invoice stays `pending` for 2 more hours (Bonum's webhook retries can land), then becomes `expired`. |

### Create an invoice

`POST /v1/invoices` → `201` with a new invoice, or `200` with an existing one.

> **A reference should identify exactly one purchase (an order id); reuse,
> closing duplicates and the paid-twice flag apply only to identical
> requests.**

**One purchase, one invoice.** If the project already has a `pending` invoice
for the same purchase, that is, with the same `reference`, `provider`,
`amount`, `description`, `returnUrl`, `metadata` (compared as JSON with key
order ignored; no metadata equals `{}`) and `items`, that has at least a minute left
before `expiresAt`, Bogts answers `200` with **that** invoice instead of
creating another, so a payer who clicks "Pay" twice sees the same QR and can't
pay twice. It is returned as it is (`expiresIn` is ignored). A request that
differs in any of those fields creates a new invoice, and so does
`"reuse": false`. Two requests that race can still both create one; the
`Idempotency-Key` header is the strict guard.

The response header `Bogts-Reused` is `true` when an existing invoice was
handed back (200) and `false` for a new one (201); a replay of the same
`Idempotency-Key` carries it too. `@gege-mn/bogts` returns it as `reused` on the
result of `invoices.create`.

| Field | Type | |
|---|---|---|
| `provider` | `"qpay"` or `"bonum"` | required |
| `amount` | integer MNT, at least 1 | required, unless you send `items` |
| `items` | [line items](#formats) | in place of `amount`. The payer's page shows the total. |
| `reference` | string, 1 to 255 characters | required. Your own id, such as an order number. It comes back in every event. |
| `description` | string, 1 to 255 characters | required. The payer sees it. |
| `returnUrl` | `http(s)` URL | optional |
| `expiresIn` | seconds, 60 to 86400 | optional, 1800 by default |
| `metadata` | up to 20 string keys (40 chars) and string values (500 chars) | optional. It comes back on the invoice and in its events. |
| `reuse` | boolean | optional, `true` by default. `false` always creates a new invoice. |

```sh
curl https://pay.example.com/v1/invoices \
  -H "Authorization: Bearer $BOGTS_API_KEY" \
  -H "Idempotency-Key: order-42" \
  -H "Content-Type: application/json" \
  -d '{"provider":"qpay","amount":49900,"reference":"order-42","description":"Order 42","returnUrl":"https://shop.example.com/orders/42"}'
```

If the provider fails, the answer is `502 provider_error`. The invoice exists
with status `failed`, and an `invoice.failed` event follows. Create a new one
to try again.

### Retrieve an invoice

`GET /v1/invoices/:id` → `200` with the invoice.

While a QPay invoice is `pending` and not past `expiresAt`, this also asks
QPay, at most once every 10 seconds per invoice, and settles a payment it
finds (you get `invoice.paid` as usual). So an app that shows the QR itself,
rather than sending the payer to `payUrl`, can poll this endpoint and is not
left waiting when QPay's callback is late. `GET /v1/invoices` (the list) reads
only what Bogts already knows.

### List invoices

`GET /v1/invoices` → a list of invoices, newest first. Filters:
`?reference=order-42` and `?status=paid`.

### Cancel an invoice

`POST /v1/invoices/:id/cancel` (no body) → `200` with the invoice, now
`cancelled`.

Only a `pending` invoice can be cancelled. For QPay, Bogts first asks QPay
whether it was paid:

- if it was paid, the invoice is settled as `paid` and the answer is `409
  conflict`;
- if QPay can't answer, nothing is cancelled and the answer is `502
  provider_error`, so a payment in an unknown state is never thrown away.

A payment that still arrives after a cancel is honoured: the invoice becomes
`paid` and you get `invoice.paid`.

## Subscriptions

A Bonum card subscription. The customer enters a card on Bonum's page. Bonum
charges it on the plan's schedule, and Bogts reports each renewal, failure and
cancellation. Plans are defined per project in `/admin` and map to Bonum plan
ids (see [self-hosting](self-hosting.md#bonum-setup)).

### The subscription object

```json
{
  "id": "01K5XA2N8C4H6J7K9M1P3Q5R7S",
  "object": "subscription",
  "plan": "pro-monthly",
  "customerRef": "user_123",
  "email": "dorj@example.com",
  "status": "active",
  "redirectUrl": null,
  "card": { "mask": "5150 23** **** 4778", "expiry": "2026/11", "bank": "Голомт банк" },
  "currentPeriod": { "start": "2026-09-25T14:10:00.000Z", "end": "2026-10-25T14:10:00.000Z" },
  "nextBillAt": "2026-10-25T14:10:00.000Z",
  "cancelledAt": null,
  "createdAt": "2026-09-25T14:08:12.000Z"
}
```

| Field | |
|---|---|
| `status` | `pending` (waiting for the card), `active`, `past_due` (a renewal failed and Bonum is retrying), `cancelled` or `failed` (the card step never completed). |
| `redirectUrl` | Bonum's card page. It is set only while the subscription is `pending`, or while a card replacement is pending. |
| `card` | The card's display details. The card token itself never leaves Bogts. |

### Create a subscription

`POST /v1/subscriptions` → `201` with the subscription, `status: "pending"`.
Send the customer to its `redirectUrl`. Afterwards Bonum sends them back
through Bogts to your `returnUrl`, with `?subscription=<id>` added. That
redirect says nothing about the outcome: wait for `subscription.active`, or
read the subscription.

| Field | Type | |
|---|---|---|
| `plan` | string | required. The plan key from `/admin`. |
| `customerRef` | string, up to 128 characters | required. Your id for the customer. |
| `email` | email | optional. Bonum uses it for receipts. |
| `returnUrl` | `http(s)` URL | required. Where the customer lands afterwards. |

```sh
curl https://pay.example.com/v1/subscriptions \
  -H "Authorization: Bearer $BOGTS_API_KEY" \
  -H "Idempotency-Key: sub-user_123-pro" \
  -H "Content-Type: application/json" \
  -d '{"plan":"pro-monthly","customerRef":"user_123","returnUrl":"https://app.example.com/billing"}'
```

Before redirecting, Bogts checks the plan against Bonum. If they differ, the
answer is `409 plan_mismatch`. The first period is charged when the card is
added, and you get `subscription.active`.

### Retrieve a subscription

`GET /v1/subscriptions/:id` → `200` with the subscription.

### List subscriptions

`GET /v1/subscriptions` → a list, newest first. Filters: `?customerRef=` and
`?status=`.

### Cancel a subscription

`DELETE /v1/subscriptions/:id` → `200` with the subscription, now
`cancelled`. Bogts deletes the mandate at Bonum, so no further payment is
taken, and emits `subscription.cancelled`. If Bonum doesn't confirm, the answer
is `502 provider_error` and nothing changes, so you can retry.

### Replace the card

`POST /v1/subscriptions/:id/card` (no body) → `200` with the subscription,
whose `redirectUrl` is now Bonum's card page. Send the customer there. When the
new card is saved you get `subscription.card_changed`. If the customer gives up,
the old card stays in place.

## Cards

A card saved with no Bonum plan behind it. The customer enters it on Bonum's
page; Bogts keeps the token and charges it only when you [create a
charge](#create-a-charge), for any amount. A customer can have several cards.
Cards belong to one project: the same `customerRef` in another project is a
different customer with its own cards.

### The card object

```json
{
  "id": "01K5XA3P0Q2R4S6T8V0W2X4Y6Z",
  "object": "card",
  "customerRef": "user_123",
  "status": "active",
  "redirectUrl": null,
  "mask": "5150 23** **** 4778",
  "expiry": "2026/11",
  "bank": "Голомт банк",
  "createdAt": "2026-09-25T14:08:12.000Z"
}
```

| Field | |
|---|---|
| `status` | `pending` (waiting for the customer on Bonum's page), `failed` (the card step didn't complete), `active` or `removed`. |
| `redirectUrl` | Bonum's card page. It is set only while the card is `pending`. |
| `mask`, `expiry`, `bank` | Display details, `null` until the card is saved. The card token itself never leaves Bogts. |

### Save a card

`POST /v1/cards` → `201` with the card, `status: "pending"`. Send the customer
to its `redirectUrl`. Afterwards Bonum sends them back through Bogts to your
`returnUrl`, with `?card=<id>` added. That redirect says nothing about the
outcome: wait for `card.saved` or `card.failed`, or read the card. The id you
get here stays the card's id.

| Field | Type | |
|---|---|---|
| `customerRef` | string, up to 128 characters | required. Your id for the customer. |
| `returnUrl` | `https` URL | required. Where the customer lands afterwards. |
| `payment` | object | optional. A first payment taken in the same step: `{ "reference", "amount" }`, or `items` in place of `amount`. |

```sh
curl https://pay.example.com/v1/cards \
  -H "Authorization: Bearer $BOGTS_API_KEY" \
  -H "Idempotency-Key: card-user_123-1" \
  -H "Content-Type: application/json" \
  -d '{"customerRef":"user_123","returnUrl":"https://app.example.com/billing","payment":{"reference":"order-42","items":[{"label":"Pro, first month","amount":49900},{"label":"Launch discount","amount":-10000}]}}'
```

Without `payment`, nothing is charged: Bonum takes 0.01 MNT to check the card,
which Bogts does not count as money. With `payment`, the amount is charged when
the card is saved and reported as an ordinary [charge](#charges)
(`charge.succeeded`, with your `reference`); `card.saved` carries its
`chargeId`. If the customer gives up, nothing is charged and no card is saved.

### Retrieve a card

`GET /v1/cards/:id` → `200` with the card.

### List cards

`GET /v1/cards` → saved cards, newest first. Filters: `?customerRef=` and
`?status=` (`active` or `removed`). A card still `pending` or `failed` is not
listed; read it by id.

### Replace a card

`POST /v1/cards/:id/replace` with `{ "returnUrl": "…" }` → `201` with a
**new** card, `pending`, for the same customer. Send the customer to its
`redirectUrl`. The old card keeps working until the new one is saved; then the
old one becomes `removed` and you get `card.replaced` with both ids. If the
customer gives up, the old card stays in place.

### Remove a card

`DELETE /v1/cards/:id` → `200` with the card, now `removed`, and a
`card.removed` event. Bogts deletes the token, so the card can't be charged
again. A charge already made on it can no longer be reversed through Bogts.

A card that a [subscription](#subscriptions) bills can't be removed or
replaced here (`409 conflict`): cancel the subscription, or use its own card
replacement.

## Charges

A charge to a saved card, for any amount: a [card](#cards) named by `cardId`,
or a subscription's card named by `subscriptionId`.

### The charge object

```json
{
  "id": "01K5XB7T2V4W6X8Y0Z1A3B5C7D",
  "object": "charge",
  "status": "succeeded",
  "amount": 5000,
  "currency": "MNT",
  "reference": "topup-7",
  "cardId": "01K5XA3P0Q2R4S6T8V0W2X4Y6Z",
  "subscriptionId": null,
  "items": null,
  "failureCode": null,
  "createdAt": "2026-09-26T09:00:00.000Z"
}
```

| Field | |
|---|---|
| `status` | `pending` (the outcome isn't known yet), `queued` (Bonum queued it and reports later), `succeeded`, `failed` or `reversed`. |
| `failureCode` | A short machine code when `failed`. It is never provider text. |

### Create a charge

`POST /v1/charges` → `201` with the charge.

| Field | Type | |
|---|---|---|
| `cardId` | string | The card to charge. Send this or `subscriptionId`. |
| `subscriptionId` | string | The subscription whose card to charge. Send this or `cardId`. |
| `amount` | integer MNT, at least 1 | required, unless you send `items` |
| `items` | [line items](#formats) | in place of `amount` |
| `reference` | string, up to 128 characters | required |

```sh
curl https://pay.example.com/v1/charges \
  -H "Authorization: Bearer $BOGTS_API_KEY" \
  -H "Idempotency-Key: topup-7" \
  -H "Content-Type: application/json" \
  -d '{"cardId":"01K5XA3P0Q2R4S6T8V0W2X4Y6Z","amount":5000,"reference":"topup-7"}'
```

A charge can finish at once (`succeeded` or `failed`) or later (`queued`, or
`pending` when Bonum didn't answer). Treat `charge.succeeded` and
`charge.failed` as the result. **Always send an `Idempotency-Key`**: a charge
whose outcome is unknown is never retried blindly by Bogts, and your retry
must not be blind either.

### Retrieve a charge

`GET /v1/charges/:id` → `200` with the charge.

### List charges

`GET /v1/charges` → a list, newest first. Filters: `?cardId=`,
`?subscriptionId=` and `?status=`.

### Reverse a charge

`POST /v1/charges/:id/reverse` (no body) → `200` with the charge, now
`reversed`, and a `charge.reversed` event. Only a `succeeded` charge can be
reversed. If Bonum doesn't confirm, the answer is `502 provider_error`.

## Events

The same events that are sent to your webhook URL (see
[webhooks.md](webhooks.md)).

### The event object

```json
{
  "id": "01K5X9Q0B2C4D6E8F0G1H3J5K7",
  "object": "event",
  "type": "invoice.paid",
  "createdAt": "2026-09-25T14:07:01.000Z",
  "data": {
    "invoiceId": "01K5X9M3QF2ZB7N8R4T6VWXY0C",
    "provider": "qpay",
    "reference": "order-42",
    "amount": 49900,
    "currency": "MNT",
    "paidAt": "2026-09-25T14:07:00.000Z",
    "metadata": { "cart": "c_981" }
  }
}
```

### List events

`GET /v1/events` → a list of events.

| Parameter | |
|---|---|
| `cursor` | Newest first (the default order). Pass the previous page's `nextCursor`. |
| `after` | **Oldest first**, starting after this event id. `after=` (empty) starts at the beginning. This is the reconciliation feed. |
| `type` | Only these types, comma separated: `?type=invoice.paid,charge.failed` |
| `limit` | 1 to 100, default 20 |

`cursor` and `after` can't be combined. The feed holds back events for their
first 5 seconds, so that an event committed a moment late can't land behind an
id you have already passed.

```sh
curl "https://pay.example.com/v1/events?after=01K5X9Q0B2C4D6E8F0G1H3J5K7&limit=100" \
  -H "Authorization: Bearer $BOGTS_API_KEY"
```

### Retrieve an event

`GET /v1/events/:id` → `200` with the event.

## Other endpoints

These are not part of the project API, but they are public:

| Endpoint | |
|---|---|
| `GET /health` | `200 {"status":"ok","configured":true,"database":true}`, or `503` with `"status":"unavailable"`. For uptime checks. |
| `GET /pay/:invoiceId` | The hosted QPay page: the QR, bank-app buttons and a countdown. |
| `GET /pay/:invoiceId/status` | `{ status, paidAt, returnUrl }`, which is what the hosted page polls. While a QPay invoice is pending, it also asks QPay, at most once every 10 seconds per invoice, in case the callback is late. Limited to 240 requests per minute per client (an IPv4 address, or an IPv6 /64), since mobile carriers put many payers behind one address. |
| `GET /return/:invoiceId` | Where Bonum sends the payer after a one-off card payment. It shows the result and, once the invoice is paid, returns them to the invoice's `returnUrl`. |
| `GET /return/s/:subscriptionId` | Where Bonum sends the customer after the card step. It redirects to the subscription's `returnUrl` with `?subscription=<id>` added. |
| `GET /return/c/:cardId` | Where Bonum sends the customer after saving a card. It redirects to the card's `returnUrl` with `?card=<id>` added. |
| `POST /hooks/bonum` | Bonum's webhook. Register it in Bonum's portal. |
| `GET` or `POST /hooks/qpay/:invoiceId` | QPay's callback, set per invoice automatically. |
