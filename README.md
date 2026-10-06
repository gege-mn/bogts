<p align="center">
  <img src=".github/assets/logo.png" width="128" height="128" alt="Bogts logo: a blue coin pouch tied with an orange cord">
</p>

<h1 align="center">Bogts (Богц)</h1>

<p align="center">
  <strong>A self-hosted payment gateway for Mongolia. Bonum and QPay behind one small
  API, running as a single Cloudflare Worker that you own.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@gege-mn/bogts"><img src="https://img.shields.io/npm/v/@gege-mn/bogts?color=0d47d2" alt="npm"></a>
  <a href="https://github.com/gege-mn/bogts/actions/workflows/ci.yml"><img src="https://github.com/gege-mn/bogts/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-0d47d2" alt="Apache-2.0"></a>
</p>

*Bogts* («Богц», said roughly "bawgts") is the traditional Mongolian coin pouch:
the place your payments go.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gege-mn/bogts/tree/main/apps/gateway)

## Why

Taking payments in Mongolia usually means integrating each provider yourself.
The easy parts are easy. The hard parts cost money quietly:

- **Bonum renewals.** A renewal webhook carries the same `transactionId` as
  the first charge. Deduplicate on it and every renewal after the first is
  dropped, while the customer is still charged. Bogts keys renewals on
  `invoiceId` and guards against crediting the first charge twice.
- **Bonum's end of a mandate.** When Bonum's retries run out it sends
  `UNSUBSCRIBED`. Ignore that and the customer can never subscribe again.
  Bogts handles it, cancels with `planId`, and verifies the webhook checksum
  with number text kept exactly as sent (`10000.00` is not `10000`).
- **QPay.** The callback is only a hint and the sandbox is flaky. Bogts treats
  every callback as "go and check", never polls on a timer (QPay asks you not
  to), checks each expired invoice exactly once, and still honours money that
  arrives late.
- **Your side.** You get signed webhooks with retries for three days, an event
  feed to reconcile from after an outage, and idempotency keys on every POST.

Your projects never hold provider credentials or card tokens, and money goes
straight to your own merchant accounts. Bogts never holds funds.

## Features

- **One deployment per company, many projects.** Each project has its own API
  key, webhook URL, signing secret and plans.
- **QPay invoices:** a QR, bank-app deeplinks and a hosted payment page.
- **Bonum:** card subscriptions, the hosted All-in-one checkout (QPay, card,
  WeChat, SonoShop), saved cards you charge whenever you choose, for any
  amount, and reversals.
- **Facts, not entitlement.** Bogts reports paid, failed, renewed, cancelled
  and expired. Your app decides what a customer gets.
- **Dashboard** at `/admin`: payments, subscriptions, cards, events with re-delivery,
  projects, plans and usage. It is protected by Cloudflare Access or a
  password, and it refuses to run with neither.
- **Your brand on the payment pages:** company name, logo, accent colour and
  support contacts, with a per-project name and logo.
- **Multilingual payment pages:** Mongolian by default, plus English, French,
  Russian, Simplified Chinese and Spanish.
- **Runs on the free plan.** One Worker and one D1 database, with no Queues.
- **`@gege-mn/bogts`:** a typed client and a webhook signature check, with no
  runtime dependencies.

## 60-second integration

```sh
pnpm add @gege-mn/bogts
```

```ts
import { Bogts, constructEvent } from '@gege-mn/bogts';

const bogts = new Bogts({ apiKey: env.BOGTS_API_KEY, baseUrl: 'https://pay.example.com' });

// 1. Checkout: create a QPay invoice and send the payer to its hosted page.
export async function checkout(order: { id: string; total: number }) {
	const invoice = await bogts.invoices.create(
		{ provider: 'qpay', amount: order.total, reference: order.id, description: `Order ${order.id}` },
		{ idempotencyKey: `order-${order.id}` } // a retry can't create a second invoice
	);
	return Response.redirect(invoice.payUrl!, 303); // or render invoice.qr / invoice.deeplinks yourself
}

// 2. Your webhook URL: verify the signature, then act once per event.id.
export async function webhook(request: Request) {
	const event = await constructEvent(request, env.BOGTS_WEBHOOK_SECRET); // throws on a bad signature
	if (event.type === 'invoice.paid') await markOrderPaid(event.data.reference, event.id);
	return new Response('ok');
}
```

That's all of it: no QPay token handling, no callback URL, no polling. The full
client guide is in [packages/client/README.md](packages/client/README.md).

## How it works

```
 your app ──HTTPS /v1 (Bearer bgk_…)──▶ ┌──────────── Bogts (one Worker) ────────────┐
    ▲                                   │  /v1       project API                      │
    │                                   │  /hooks    Bonum + QPay callbacks ◀──────── │── Bonum, QPay
    │  signed webhooks                  │  /pay      hosted QPay page                 │
    └───(Bogts-Signature, retries)───── │  /admin    dashboard (Access or password)   │
                                        │  cron      every minute: deliver + sweep    │
                                        └──────────────────┬──────────────────────────┘
                                                           ▼
                                  D1: projects, invoices, subscriptions, cards, charges,
                                  encrypted card tokens, ledger, event outbox
```

Every provider payment is written through a ledger with a unique
`(provider, provider_ref)`, together with its state change and exactly one
event, so replays and retries are harmless.

## Supported flows

| Flow | Provider | API |
|---|---|---|
| One-off invoice: QR, deeplinks, hosted page | QPay | `POST /v1/invoices` with `provider: "qpay"` |
| Hosted All-in-one checkout | Bonum | `POST /v1/invoices` with `provider: "bonum"` |
| Card subscription: renewals, failures, cancel, card replacement | Bonum | `/v1/subscriptions` |
| Save a card with no plan; replace or remove it | Bonum | `/v1/cards` |
| Charge a saved card, and reverse it | Bonum | `/v1/charges` |

## Docs

- [Self-hosting](docs/self-hosting.md): deploy, providers, admin auth, custom domain, upgrades, backups
- [API reference](docs/api.md)
- [Webhooks](docs/webhooks.md): events, signatures, retries, reconciling
- [Bonum](docs/providers/bonum.md) (and its [integration pitfalls](docs/providers/bonum-pitfalls.md)) and [QPay](docs/providers/qpay.md) notes
- [FAQ](docs/faq.md)
- Design: [design](docs/design.md), [decisions](docs/decisions.md), [contracts](docs/contracts.md)

## Status

**0.1, pre-release.** The QPay flow, the event outbox and the client are
built and tested against the QPay sandbox. The Bonum flows and the dashboard
are landing now, then a staging run on the Bonum sandbox.

Later: e-barimt (VAT receipts; the columns are already reserved), more
providers, and a hosted option. See [CHANGELOG.md](CHANGELOG.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md),
and report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE).

---

Built by [gege.mn](https://gege.mn) in Ulaanbaatar.
