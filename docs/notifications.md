# Notifications

Bogts can tell **you**, the people running the deployment, each time money
comes in: a message in Discord, in Telegram, or a JSON POST to a URL of
yours. This is separate from [webhooks](webhooks.md), which tell a project's
backend what happened so it can act. Nothing here needs a project to change.

Notifications are optional. With no channel set up, nothing is sent.

- [Channels](#channels)
- [What is sent](#what-is-sent)
- [Discord](#discord)
- [Telegram](#telegram)
- [Webhook (JSON)](#webhook-json)
- [Timing, retries and pausing](#timing-retries-and-pausing)

## Channels

A **channel** is one place a notification goes. Add as many as you like, of
any kind, in two places:

- **Settings → Notifications**: global channels. They hear about every
  project.
- **Projects → a project → Notifications**: that project's channels. They
  hear about that project only.

A payment is sent to the project's channels and to the global ones, once
each. Each scope takes up to 20 channels.

Each channel lists what it wants to be notified about. Today there is one
thing to pick:

| Type | When |
|---|---|
| `payment.received` | Money came in: a paid invoice, a subscription payment (the first one or a renewal), or a charge of a saved card |

Unpaid, expired and failed payments send nothing, and neither does a
reversal.

A channel's credentials (the Discord URL, the Telegram bot token, the webhook
signing secret) are stored encrypted and never shown again. To change where a
channel sends, delete it and add it again. **Send test** sends a made-up
payment, marked `[Test]`, and shows what the receiver answered when it
refuses. Adding a channel sends one too, unless you untick it; the channel is
kept either way. The switch on a channel pauses and resumes it. Adding, editing, pausing, testing and deleting a channel are recorded
in the audit log.

## What is sent

Every notification carries the amount, the project, what was paid (an
invoice, a subscription payment or a card charge), the provider, and what
Bogts knows about it: the project's `reference`, the `customerRef`, the plan
key and the invoice description, whichever apply. Discord and Telegram
messages link to the payment in `/admin` and end with the deployment's host,
so a staging deployment and a production one sharing a chat can be told
apart. A payment through a provider connected in its sandbox is marked
`[Sandbox]`.

The amount is what the payer paid. Bogts does not know the provider's fees.

## Discord

In Discord, open the channel's settings → **Integrations → Webhooks → New
webhook**, and copy the webhook URL. Paste it as the channel's URL. To post
into a thread, add `?thread_id=<id>` to the URL.

Messages never mention anyone, whatever a reference or a description says.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Add the bot to the group or channel (in a channel it must be an admin), or
   send it a message for a private chat.
3. In the form, paste the token and press **Find my chats**: Bogts asks
   Telegram which chats the bot has seen and you pick one. You can also type
   the chat id yourself: a number, negative for groups and channels, or a
   public channel's `@channelname`. For a group with topics, the topic id is
   optional.

**Find my chats** does not work for a bot that has a webhook set (Telegram
refuses it); type the chat id for such a bot.

## Webhook (JSON)

Each notification is POSTed to your URL (`https://`; `http://localhost` only
while a provider is in its sandbox):

```http
POST /hooks/payments HTTP/1.1
Content-Type: application/json
User-Agent: Bogts/<version>
Bogts-Notification-Id: 01M4NSMCFTNNCH22H3EG5XA878
Bogts-Notification-Type: payment.received
Bogts-Signature: t=1791732887,v1=5f0c3c1e9a7d…

{
  "id": "01M4NSMCFTNNCH22H3EG5XA878",
  "object": "notification",
  "type": "payment.received",
  "createdAt": "2026-10-11T15:34:47.888Z",
  "origin": "https://payments.example.com",
  "project": { "id": "01M4NSKW904NZEM33DC98TPMN6", "name": "Shop", "slug": "shop" },
  "data": {
    "ledgerId": "01M4NT0000000000000000LED1",
    "kind": "invoice",
    "provider": "qpay",
    "amount": 49900,
    "currency": "MNT",
    "subjectId": "01M4NT0000000000000000INV1",
    "reference": "order_1001",
    "description": "Pro plan",
    "sandbox": false,
    "dashboardUrl": "https://payments.example.com/admin/payments/01M4NT0000000000000000INV1"
  }
}
```

| Field | |
|---|---|
| `id` | The notification's id. The same on every retry, so skip one you have seen. |
| `createdAt` | When the payment was recorded (ISO-8601 UTC) |
| `test` | `true` on a message from **Send test**; absent otherwise |
| `origin` | The deployment's `PUBLIC_ORIGIN`, or `null` when it is not set |
| `data.kind` | `invoice`, `subscription` or `charge` |
| `data.subjectId` | The invoice, subscription or charge id |
| `data.amount` | Integer MNT |
| `data.reference` | Invoices and charges: the project's own reference |
| `data.description` | Invoices: the description the payer saw |
| `data.customerRef` | Subscriptions and charges: the project's customer id |
| `data.plan` | Subscriptions: the plan key |
| `data.sandbox` | `true` when the provider is connected in its sandbox |
| `data.dashboardUrl` | The payment in `/admin`, or `null` without `PUBLIC_ORIGIN` |

Fields that do not apply are left out. New fields and new `type` values can
be added, so ignore what you do not know.

The signing secret (`bgwh_…`) is shown once, when the channel is added. The
`Bogts-Signature` header is the same scheme as project webhooks: verify it
[the same way](webhooks.md#verifying-the-signature), with the channel's
secret. Answer any 2xx within 10 seconds; a redirect counts as a failure.

## Timing, retries and pausing

A notification usually goes out within seconds of the payment, right after
the request or provider callback that recorded it. Anything that pass missed,
and payments found by the expiry sweep or by renewal reconciliation, go out
from the every-minute cron.

A send that fails is tried again after 1 minute, 5 minutes, 30 minutes,
2 hours and then every 6 hours, until the next attempt would fall more than
**24 hours** after the notification was written. Then it is dropped. The
channel shows **Failing** with the last error until a send succeeds. One
channel failing never delays another, and never affects a payment or a
project's webhooks.

Sending is **at least once**: after a timeout, the same notification can
arrive twice.

**Pause** stops a channel without deleting it. A payment received while a
channel is paused is not sent later when it is resumed, and a new channel
only hears about payments from the moment it was added.
