# Webhooks

Bogts tells your app about payments by POSTing **events** to the project's
webhook URL (set in `/admin` → Projects → Webhook). The same events are
available from the [event feed](#reconciling-with-the-event-feed), so an app
that was down can catch up.

- [The request](#the-request)
- [Event types](#event-types)
- [Acting on events: by reference, idempotently](#acting-on-events-by-reference-idempotently)
- [Corrections and reconciliation](#corrections-and-reconciliation)
- [Verifying the signature](#verifying-the-signature): [TypeScript](#typescript), [Python](#python), [Go](#go)
- [Answering, retries and backoff](#answering-retries-and-backoff)
- [Reconciling with the event feed](#reconciling-with-the-event-feed)

## The request

```http
POST /webhooks/bogts HTTP/1.1
Host: shop.example.com
Content-Type: application/json
User-Agent: Bogts/<version>
Bogts-Event-Id: 01K5X9Q0B2C4D6E8F0G1H3J5K7
Bogts-Event-Type: invoice.paid
Bogts-Signature: t=1790345221,v1=5f0c3c1e9a7d…

{"id":"01K5X9Q0B2C4D6E8F0G1H3J5K7","object":"event","type":"invoice.paid","createdAt":"2026-09-25T14:07:01.000Z","data":{"invoiceId":"01K5X9M3QF2ZB7N8R4T6VWXY0C","provider":"qpay","reference":"order-42","amount":49900,"currency":"MNT","paidAt":"2026-09-25T14:07:00.000Z","metadata":null}}
```

The body is the [event object](api.md#events):
`{ id, object: "event", type, createdAt, data }`. Times are ISO-8601 UTC
strings and amounts are integer MNT.

## Event types

Bogts reports facts. What a fact entitles your customer to is up to your app.

| Type | When |
|---|---|
| `invoice.paid` | The invoice was paid. This can also follow `invoice.expired` or a cancel, when money arrives late. With `duplicateOfInvoiceId`, the same purchase (an identical request) was already paid by another invoice: refund one. |
| `invoice.expired` | The invoice passed `expiresAt` unpaid (QPay: checked with QPay at expiry; Bonum: 2 hours after `expiresAt`, since Bonum has no status API). It can still be followed by `invoice.paid`. |
| `invoice.failed` | The provider couldn't create the invoice, or Bonum reported the payment failed. |
| `subscription.active` | The card was saved and the first period was charged. |
| `subscription.renewed` | A renewal was charged. `period` is the new period. |
| `subscription.payment_failed` | A payment failed. With `reason: "payment_failed"` a renewal was declined and Bonum retries on the plan's schedule. With `reason: "checkout_failed"` the first card step failed (or Bonum refused the checkout) and the subscription is `failed`. With `reason: "renewal_missing"` no renewal arrived for the period and Bonum shows none billed; the subscription is `past_due`. |
| `subscription.cancelled` | The subscription ended. `reason` says why. |
| `subscription.card_changed` | A card replacement finished. `cardMask` is the new card. |
| `charge.succeeded` | A saved-card charge went through. |
| `charge.failed` | A saved-card charge was declined. `failureCode` says why. |
| `charge.reversed` | A charge was reversed. |
| `card.saved` | A card was saved. With `chargeId`, its first payment was taken too (that charge has its own `charge.succeeded`). |
| `card.failed` | The card step didn't complete, or Bonum refused it. Nothing was charged. |
| `card.replaced` | A replacement card was saved. `cardId` is the new card and `replacesCardId` the old one, now removed. |
| `card.removed` | A card was removed and its token deleted. |

### `data` for `invoice.*`

```json
{
  "invoiceId": "01K5X9M3QF2ZB7N8R4T6VWXY0C",
  "provider": "qpay",
  "reference": "order-42",
  "amount": 49900,
  "currency": "MNT",
  "paidAt": "2026-09-25T14:07:00.000Z",
  "metadata": { "cart": "c_981" }
}
```

`paidAt` is present on `invoice.paid` only. `items` is present when the
invoice was created with [line items](api.md#formats).

`duplicateOfInvoiceId` is present on `invoice.paid` only when another invoice
of the project for the **same purchase** was paid first; it is that invoice's
id. The same purchase means an identical request: the same `reference`,
`provider`, `amount`, `description`, `returnUrl` and `metadata`. The payer paid twice for one purchase. The money moved, so the
event still reports it: don't grant the order twice (see
[below](#acting-on-events-by-reference-idempotently)), and refund one payment.
The dashboard's Overview lists it under "Needs attention".

### `data` for `subscription.*`

```json
{
  "subscriptionId": "01K5XA2N8C4H6J7K9M1P3Q5R7S",
  "plan": "pro-monthly",
  "customerRef": "user_123",
  "amount": 49000,
  "currency": "MNT",
  "period": { "start": "2026-10-25T14:10:00.000Z", "end": "2026-11-25T14:10:00.000Z" },
  "nextBillAt": "2026-11-25T14:10:00.000Z",
  "cardMask": "5150 23** **** 4778"
}
```

| Field | |
|---|---|
| `amount` | The amount charged, on `active` (the first charge) and `renewed`. Absent otherwise. |
| `period` | The paid period, on `active` and `renewed`. Extend access to `period.end`. |
| `nextBillAt` | When Bonum will charge next, or `null`. |
| `reason` | On `cancelled`: `cancelled_by_project` (your `DELETE`), `cancelled_by_admin` (the dashboard), `retries_exhausted` (Bonum gave up after failed renewals) or `provider_cancelled` (reconciliation found it ended at Bonum, whose webhook never arrived). On `payment_failed`: `payment_failed`, `checkout_failed` or `renewal_missing`. |
| `cardMask` | On `active` and `card_changed`. |

### `data` for `charge.*`

```json
{
  "chargeId": "01K5XB7T2V4W6X8Y0Z1A3B5C7D",
  "cardId": "01K5XA3P0Q2R4S6T8V0W2X4Y6Z",
  "subscriptionId": "01K5XA2N8C4H6J7K9M1P3Q5R7S",
  "customerRef": "user_123",
  "reference": "topup-7",
  "amount": 5000,
  "currency": "MNT",
  "failureCode": null
}
```

`failureCode` is set on `charge.failed`. It is a short machine code, never
provider text. `subscriptionId` is `null` for a charge made by `cardId`.
`items` is present when the charge was created with
[line items](api.md#formats).

### `data` for `card.*`

```json
{
  "cardId": "01K5XA3P0Q2R4S6T8V0W2X4Y6Z",
  "customerRef": "user_123",
  "cardMask": "5150 23** **** 4778",
  "chargeId": "01K5XB7T2V4W6X8Y0Z1A3B5C7D"
}
```

| Field | |
|---|---|
| `cardMask` | On `saved` and `replaced`. |
| `chargeId` | On `saved` and `replaced`, when a first payment was taken with the card step. |
| `replacesCardId` | On `replaced`: the old card. |
| `reason` | On `failed`: `checkout_failed`. On `removed`: `removed_by_project` or `removed_by_admin`. |

New event types may be added. Ignore types you don't know and answer 2xx.

## Acting on events: by reference, idempotently

> **A reference should identify exactly one purchase (an order id); reuse,
> closing duplicates and the paid-twice flag apply only to identical
> requests.** Two invoices that share a `reference` but differ in `amount`,
> `description`, `returnUrl`, `metadata` or `provider` are two purchases to
> Bogts: neither is cancelled when the other is paid, and paying both is not
> flagged.

- **Grant by `reference`, not by invoice id.** One purchase can have several
  invoices (the payer reopened the page, your app retried). Bogts hands back
  the pending one where it can and cancels the rest once one is paid, but a
  QR already on a phone can still be paid. Mark the *order* `reference` paid
  on the first `invoice.paid` and treat every later `invoice.paid` for the
  same reference as "already done" (it will usually carry
  `duplicateOfInvoiceId`).
- **Make the grant idempotent.** Store each processed `event.id`, and make
  the effect itself safe to repeat: "set order 42 paid" rather than "add
  credit". For subscriptions, extend access to `period.end` only if it is
  later than what you have.
- **An invoice you never see an event for** was cancelled because another
  invoice for the same purchase was paid. Cancelling emits no event (neither does
  your own `POST /v1/invoices/:id/cancel`).

## Corrections and reconciliation

Bogts reports facts as it learns them, and a later fact can correct an
earlier one. Handle events in any order and let the newest fact win:

| First | Then | Why |
|---|---|---|
| `invoice.expired` | `invoice.paid` | The payer paid after expiry, or QPay's callback was lost and a later check found the payment. Honour it: the money moved. |
| (invoice `cancelled`, no event) | `invoice.paid` | A cancelled invoice's QR was still paid. |
| `subscription.payment_failed` | `subscription.renewed` | Bonum's retry succeeded, or reconciliation found the renewal billed. |

What Bogts does when a provider's notification never arrives:

- **QPay invoices.** The callback is only a hint: Bogts re-checks with QPay's
  `payment/check` and trusts nothing in the callback request. Each invoice is
  checked once at `expiresAt`, and one more time about **24 hours** later if
  it ended `expired` (QPay keeps accepting payment on an old QR). A payment
  found then is settled, and `invoice.paid` follows `invoice.expired`.
- **Bonum hosted invoices.** Bonum has no status API, so a pending Bonum
  invoice becomes `expired` only **2 hours** after `expiresAt`, leaving room
  for Bonum's webhook retries. A `PAYMENT` webhook after that still settles it.
- **Bonum renewals.** Every hour, each live subscription whose `nextBillAt` is
  more than **6 hours** past with no renewal is looked up at Bonum:
  - billed (Bonum charged after our last credit, and its next bill date
    moved on, which a declined attempt doesn't do): `subscription.renewed`,
    exactly as the webhook would have sent it (the late webhook, if it ever
    arrives, is recognised as the same charge and not credited again). A
    charge Bonum shows that can't be matched to a billing period is not
    credited: it is rechecked daily and shown on the dashboard's "Needs
    attention" for a person to check;
  - cancelled at Bonum: `subscription.cancelled` with `reason:
    "provider_cancelled"`;
  - not billed: the subscription goes `past_due` with
    `subscription.payment_failed`, `reason: "renewal_missing"` (once per
    period). Keep access through your grace period; a later
    `subscription.renewed` clears it.

## Verifying the signature

```
Bogts-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

- `secret` is the project's signing secret (`bgwh_…`), used as UTF-8 bytes.
- The signed message is the timestamp, a dot, and the **raw request body**,
  exactly as received. Verify before you parse, because re-serialized JSON
  won't match.
- Compare in constant time. Accept the signature if **any** `v1=` value
  matches; there may be more than one.
- Reject a timestamp more than 5 minutes from your clock. That stops an old
  request from being replayed. Every attempt, retries included, is signed
  afresh.
- While you rotate the signing secret, accept either the old or the new one.

### TypeScript

With [`@gege-mn/bogts`](../packages/client/README.md), for any Fetch-API runtime
(Workers, SvelteKit, Hono, Deno, Bun, Node 18+):

```ts
import { constructEvent, BogtsSignatureError } from '@gege-mn/bogts';

export async function POST(request: Request): Promise<Response> {
	let event;
	try {
		event = await constructEvent(request, env.BOGTS_WEBHOOK_SECRET);
	} catch (err) {
		if (err instanceof BogtsSignatureError) return new Response(err.reason, { status: 400 });
		throw err;
	}
	if (await alreadyProcessed(event.id)) return new Response('ok');

	switch (event.type) {
		case 'invoice.paid':
			await markOrderPaid(event.data.reference, event.data.amount);
			break;
		case 'subscription.renewed':
			await extendAccess(event.data.customerRef, event.data.period?.end);
			break;
	}
	await rememberProcessed(event.id);
	return new Response('ok');
}
```

With a raw body in hand (Express, Hono), use
`verifyWebhook(rawBody, request.headers['bogts-signature'], secret)`.

### Python

Standard library only. The example uses Flask, which gives you the raw body
through `request.get_data()`.

```python
import hashlib
import hmac
import json
import time

TOLERANCE = 300  # seconds


def verify_bogts(raw: bytes, header: str | None, secret: str) -> dict:
    """Returns the event, or raises ValueError."""
    if not header:
        raise ValueError("missing Bogts-Signature")
    timestamp, signatures = None, []
    for part in header.split(","):
        key, _, value = part.strip().partition("=")
        if key == "t" and value.isdigit():
            timestamp = int(value)
        elif key == "v1":
            signatures.append(value.lower())
    if timestamp is None or not signatures:
        raise ValueError("malformed Bogts-Signature")
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + raw, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, s) for s in signatures):
        raise ValueError("signature mismatch")
    if abs(time.time() - timestamp) > TOLERANCE:
        raise ValueError("timestamp out of tolerance")
    return json.loads(raw)


# Flask
from flask import Flask, request

app = Flask(__name__)


@app.post("/webhooks/bogts")
def bogts_webhook():
    try:
        event = verify_bogts(request.get_data(), request.headers.get("Bogts-Signature"), BOGTS_WEBHOOK_SECRET)
    except ValueError as err:
        return str(err), 400
    if event["type"] == "invoice.paid":
        mark_order_paid(event["data"]["reference"], event["id"])  # once per event id
    return "ok"
```

### Go

Standard library only.

```go
package bogts

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const Tolerance = 5 * time.Minute

var ErrSignature = errors.New("bogts: invalid signature")

// Verify checks a Bogts-Signature header against the raw body.
func Verify(body []byte, header, secret string, now time.Time) error {
	var ts int64 = -1
	var sigs []string
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch key {
		case "t":
			n, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return ErrSignature
			}
			ts = n
		case "v1":
			sigs = append(sigs, strings.ToLower(value))
		}
	}
	if ts < 0 || len(sigs) == 0 {
		return ErrSignature
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts, 10) + "."))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	matched := false
	for _, s := range sigs {
		if hmac.Equal([]byte(expected), []byte(s)) {
			matched = true
		}
	}
	if !matched {
		return ErrSignature
	}
	if math.Abs(float64(now.Unix()-ts)) > Tolerance.Seconds() {
		return ErrSignature
	}
	return nil
}

// Handler reads the raw body, verifies it, and passes it on.
func Handler(secret string, handle func(body []byte) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		if err := Verify(body, r.Header.Get("Bogts-Signature"), secret, time.Now()); err != nil {
			http.Error(w, "bad signature", http.StatusBadRequest)
			return
		}
		if err := handle(body); err != nil { // json.Unmarshal, then act once per event id
			http.Error(w, "retry", http.StatusInternalServerError)
			return
		}
		w.Write([]byte("ok"))
	}
}
```

## Answering, retries and backoff

Answer any **2xx within 10 seconds**. Anything else counts as a failure: another
status, a timeout, a network error, or a **redirect** (Bogts never follows one,
so use the final URL). Do slow work after answering, or in a queue.

The first attempt usually goes out within seconds, right after the request
or provider callback that caused the event. Events from the expiry sweep, and
anything that first attempt missed, go out from the every-minute cron within
about two minutes. After a
failure, Bogts waits and tries again:

| After failure | 1 | 2 | 3 | 4 | 5 | 6 | 7 and later |
|---|---|---|---|---|---|---|---|
| Next attempt in | 1 min | 5 min | 30 min | 2 h | 6 h | 12 h | 24 h |

Bogts stops when the next attempt would fall more than **3 days** after the
event was created, and marks the delivery failed. Every attempt, with its
status, timing and the first 2 KB of your response, is on the event's page in
`/admin`, where **Re-deliver** sends it again at any time.

Delivery is **at least once**. The same event can arrive twice (after a
timeout, for example), and events can arrive out of order. So:

- store each processed `event.id` and skip repeats;
- act on the event's facts rather than on its arrival order. For example,
  extend access to `period.end` only if that is later than what you have.

An event emitted while the project has no webhook URL is recorded but not
sent. Set the URL and re-deliver it, or read it from the feed.

## Reconciling with the event feed

Webhooks are the fast path. The feed is the **source of truth you can always
return to**: after an outage, a lost deploy, or when you first switch on.

`GET /v1/events?after=<last id you processed>` returns the events after that
id, oldest first. Store the last id, and on start-up (or on a timer) page
through until `hasMore` is `false`. Feed the events to the **same idempotent
handler** as your webhook, and your state converges no matter what was missed.

```ts
let cursor = await loadCursor(); // undefined the first time: start from the beginning
for await (const event of bogts.events.iterate({ after: cursor })) {
	await handleEvent(event); // the webhook handler, deduplicated by event.id
	await saveCursor((cursor = event.id));
}
```

Without the client:

```sh
curl "https://pay.example.com/v1/events?after=01K5X9Q0B2C4D6E8F0G1H3J5K7&limit=100" \
  -H "Authorization: Bearer $BOGTS_API_KEY"
```

The feed holds back events for their first 5 seconds. Ids are minted in
parallel, and the delay keeps an event committed a moment late from landing
behind an id you have already passed. See [api.md](api.md#list-events) for all
the parameters.
