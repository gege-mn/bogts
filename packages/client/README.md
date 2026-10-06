<img src="https://raw.githubusercontent.com/gege-mn/bogts/main/.github/assets/logo.png" width="96" height="96" align="right" alt="Bogts logo">

# @gege-mn/bogts

[![npm](https://img.shields.io/npm/v/@gege-mn/bogts?color=0d47d2)](https://www.npmjs.com/package/@gege-mn/bogts)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@gege-mn/bogts?color=0d47d2)](https://bundlephobia.com/package/@gege-mn/bogts)

The typed client for [Bogts](https://github.com/gege-mn/bogts) («Богц»), the
open-source, self-hosted payment gateway for Mongolia (Bonum and QPay), plus the
webhook signature check.

- No runtime dependencies. It uses `fetch` and Web Crypto only.
- ESM only (`import`); Node ≥ 20.19 can also `require()` it.
- Works in Cloudflare Workers, Node ≥ 20, Deno and Bun.
- Use it on the server only, because it carries your project's API key.

```sh
pnpm add @gege-mn/bogts
```

## The client

```ts
import { Bogts, BogtsError } from '@gege-mn/bogts';

const bogts = new Bogts({
	apiKey: env.BOGTS_API_KEY, // bgk_…
	baseUrl: 'https://pay.example.com' // your deployment
});

// A QPay invoice: show `qr.image` or the bank `deeplinks`, or send the payer to `payUrl`.
// Asking again with an identical request (same reference, provider, amount,
// description, returnUrl and metadata) returns the same pending invoice, with
// `reused: true` (pass `reuse: false` to always get a new one).
const invoice = await bogts.invoices.create({
	provider: 'qpay',
	amount: 49_900, // integer MNT
	reference: 'order-42',
	description: 'Order 42'
});
invoice.reused; // false: a new invoice (HTTP 201); true: the pending one handed back (200)

// A Bonum card subscription: send the customer to `redirectUrl`.
const sub = await bogts.subscriptions.create({
	plan: 'pro-monthly',
	customerRef: 'user_123',
	returnUrl: 'https://app.example.com/billing'
});

// A saved card with no plan: send the customer to `redirectUrl`, then wait for `card.saved`.
const card = await bogts.cards.create({ customerRef: 'user_123', returnUrl: 'https://app.example.com/billing' });

// Later, once `card.saved` has arrived for `card.id`:
try {
	// Any amount, as `amount` or as `items` (a discount is a negative line).
	await bogts.charges.create({
		cardId: card.id,
		items: [
			{ label: 'Top-up', amount: 5_000 },
			{ label: 'Loyalty discount', amount: -500 }
		],
		reference: 'topup-7'
	});
} catch (err) {
	if (err instanceof BogtsError) console.log(err.status, err.code, err.message);
}
```

| Namespace | Methods |
|---|---|
| `invoices` | `create`, `get`, `list`, `cancel` |
| `subscriptions` | `create`, `get`, `list`, `cancel`, `replaceCard` |
| `cards` | `create`, `get`, `list`, `replace`, `remove` |
| `charges` | `create`, `get`, `list`, `reverse` |
| `events` | `get`, `list`, `iterate` |

- **Idempotency:** every POST sends an `Idempotency-Key`. Pass your own with
  `{ idempotencyKey: 'order-42' }` so a retry after a timeout can't create a
  second invoice. When you leave it out, the client generates a random UUID,
  which protects nothing across retries.
- **Errors:** any non-2xx answer throws `BogtsError(status, code, message)`.
  The message is safe to show. A request that got no answer has status `0` and
  code `network_error`.
- **Lists** return `{ object: 'list', data, hasMore, nextCursor }`. To get the
  next page, pass `nextCursor` back as `cursor`.
- **Types:** all timestamps are ISO-8601 UTC strings, and all amounts are
  integer MNT.

## Webhooks

Bogts POSTs every event to your project's webhook URL with these headers:

```
Bogts-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
Bogts-Event-Id: 01K…
Bogts-Event-Type: invoice.paid
```

Verify the raw body **before** you parse it. Answer 2xx quickly. Bogts treats
any other answer, or no answer within 10 s, as a failure and retries after
1m, 5m, 30m, 2h, 6h, 12h and 24h, then every 24h for up to 3 days.
Delivery is at least once, so **process each `event.id` only once**.

### SvelteKit

```ts
// src/routes/webhooks/bogts/+server.ts
import { constructEvent, BogtsSignatureError } from '@gege-mn/bogts';
import { env } from '$env/dynamic/private';

export async function POST({ request }) {
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
			await markOrderPaid(event.data.reference, event.data.amount); // data is typed per event
			break;
		case 'subscription.renewed':
			await extendPlan(event.data.customerRef, event.data.period?.end);
			break;
		case 'subscription.cancelled':
			await endPlan(event.data.customerRef, event.data.reason);
			break;
	}
	await rememberProcessed(event.id);
	return new Response('ok');
}
```

### Hono (Workers, Deno, Bun, Node)

```ts
import { Hono } from 'hono';
import { verifyWebhook, BogtsSignatureError } from '@gege-mn/bogts';

const app = new Hono<{ Bindings: { BOGTS_WEBHOOK_SECRET: string } }>();

app.post('/webhooks/bogts', async (c) => {
	const raw = await c.req.text();
	try {
		const event = await verifyWebhook(raw, c.req.header('Bogts-Signature'), c.env.BOGTS_WEBHOOK_SECRET);
		// … handle event.type, keyed by event.id
		return c.text('ok');
	} catch (err) {
		if (err instanceof BogtsSignatureError) return c.text(err.reason, 400);
		throw err;
	}
});
```

`verifyWebhook(rawBody, signatureHeader, secret, { toleranceSec = 300 })`:

- `rawBody` can be a `string`, `Uint8Array` or `ArrayBuffer`. It must be the
  exact bytes you received, not re-serialized JSON.
- `secret` is the project's `bgwh_…` signing secret. During a rotation, pass
  an array and any one matching secret is accepted.
- A header with several `v1=` values passes when any one of them matches.
- It throws `BogtsSignatureError` with a `reason`: `missing_header`,
  `malformed_header`, `no_signature`, `mismatch`,
  `timestamp_out_of_tolerance` or `invalid_payload`.

`constructEvent(request, secret, options)` does the same for a Fetch API
`Request`.

## Reconciling after an outage

The event feed returns the same events that were sent as webhooks, oldest
first, starting after an id you store:

```ts
let last = await loadCursor(); // undefined the first time
for await (const event of bogts.events.iterate({ after: last })) {
	await handle(event); // the same idempotent handler as the webhook
	await saveCursor((last = event.id));
}
```

The feed holds back events for their first 5 seconds. Ids are minted in
parallel, so this delay keeps a later-committed event from landing behind an
id you have already passed.

## License

Apache-2.0
