/**
 * The complete D1 schema. Change it here, then `pnpm db:generate`.
 *
 * Conventions (docs/contracts.md):
 *  - ids are ULIDs (text), minted by `newId()`;
 *  - timestamps are integer epoch-ms UTC;
 *  - money is integer MNT;
 *  - secrets at rest (card tokens, provider tokens, webhook secrets) are
 *    `encrypt()`ed text, column names end in `Enc`;
 *  - enums are text with a TypeScript union (`text({ enum })`), no CHECKs, so
 *    adding a value never needs a table rebuild.
 */
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/* ------------------------------------------------------------------ *
 * Enums
 * ------------------------------------------------------------------ */

export const PROVIDERS = ['bonum', 'qpay'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PLAN_INTERVALS = ['weekly', 'monthly', 'yearly'] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];

export const INVOICE_STATUSES = ['pending', 'paid', 'expired', 'failed', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const CARD_STATUSES = ['active', 'removed'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const CARD_SETUP_STATUSES = ['pending', 'completed', 'failed'] as const;
export type CardSetupStatus = (typeof CARD_SETUP_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = ['pending', 'active', 'past_due', 'cancelled', 'failed'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const CHARGE_STATUSES = ['pending', 'queued', 'succeeded', 'failed', 'reversed'] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

export const LEDGER_KINDS = ['invoice', 'subscription', 'charge'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const DELIVERY_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** A bank app link on a QPay invoice (QPay's `urls[]`). */
export type Deeplink = { name: string; description?: string; logo?: string; link: string };

/**
 * One line of what a payment is for. `amount` is integer MNT per unit and is
 * negative for a discount; the payment's `amount` is the sum of every line's
 * `amount * quantity`. Echoed back, never interpreted.
 */
export type LineItem = { label: string; amount: number; quantity: number };

/** Free-form key/value pairs a project attaches to an invoice. Echoed back, never interpreted. */
export type Metadata = Record<string, string>;

/* ------------------------------------------------------------------ *
 * Projects and plans
 * ------------------------------------------------------------------ */

/** One project of the company running this deployment: its API key, webhook and plans. */
export const project = sqliteTable(
	'project',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		/** URL-safe handle for the dashboard, `[a-z0-9-]` */
		slug: text('slug').notNull().unique(),
		/** sha256 hex of the full `bgk_…` key; the key itself is shown once and never stored */
		apiKeyHash: text('api_key_hash').notNull().unique(),
		/** `bgk_` + 8 characters, for the dashboard to tell keys apart */
		apiKeyPrefix: text('api_key_prefix').notNull(),
		/** After a rotation, the old key's hash keeps working until `previousApiKeyExpiresAt` (24 h) */
		previousApiKeyHash: text('previous_api_key_hash').unique(),
		previousApiKeyExpiresAt: integer('previous_api_key_expires_at'),
		/** The previous key's display prefix, to name it in the dashboard (null for rotations before it was kept) */
		previousApiKeyPrefix: text('previous_api_key_prefix'),
		/** Where events are POSTed; null = events are recorded (and in the feed) but not pushed */
		webhookUrl: text('webhook_url'),
		/** `encrypt(bgwh_…)`: signs `Bogts-Signature` */
		webhookSecretEnc: text('webhook_secret_enc').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		/** Archived projects fail API auth; their history stays. Projects are never deleted. */
		archivedAt: integer('archived_at'),
		/** Public pay pages: the brand name shown to payers instead of the company name (one company, several brands) */
		displayName: text('display_name'),
		/** Public pay pages: a `brand_logo.hash` that replaces the company logo for this project */
		logoHash: text('logo_hash')
	}
);

/** A plan key a project sells, mapped to a Bonum payment plan (made in Bonum's portal). */
export const plan = sqliteTable(
	'plan',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id),
		/** What the project sends as `plan`, e.g. `pro-monthly`. Unique per project. */
		key: text('key').notNull(),
		name: text('name').notNull(),
		provider: text('provider', { enum: ['bonum'] })
			.notNull()
			.default('bonum'),
		/** Bonum `planId` */
		providerPlanId: integer('provider_plan_id').notNull(),
		/** Integer MNT; checked against Bonum's plan before checkout */
		amount: integer('amount').notNull(),
		interval: text('interval', { enum: PLAN_INTERVALS }).notNull(),
		active: integer('active', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [uniqueIndex('plan_project_key_uq').on(t.projectId, t.key)]
);

/* ------------------------------------------------------------------ *
 * Payments
 * ------------------------------------------------------------------ */

/** A one-off payment request: a QPay QR invoice or a Bonum hosted (All-in-one) invoice. */
export const invoice = sqliteTable(
	'invoice',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id),
		provider: text('provider', { enum: PROVIDERS }).notNull(),
		amount: integer('amount').notNull(),
		currency: text('currency', { enum: ['MNT'] })
			.notNull()
			.default('MNT'),
		/** The project's own order reference. Not unique: an expired order can be invoiced again. */
		reference: text('reference').notNull(),
		description: text('description').notNull(),
		status: text('status', { enum: INVOICE_STATUSES }).notNull().default('pending'),
		/** QPay `invoice_id` / Bonum `invoiceId`, once the provider answered */
		providerInvoiceId: text('provider_invoice_id'),
		/** The payment's id at the provider (QPay `payment_id`, Bonum transaction), once paid */
		providerTransactionId: text('provider_transaction_id'),
		/** Bonum hosted checkout URL */
		redirectUrl: text('redirect_url'),
		/** QPay `qr_text` */
		qrText: text('qr_text'),
		/** QPay `qr_image` (base64 PNG), when kept */
		qrImage: text('qr_image'),
		/** QPay bank app links */
		deeplinks: text('deeplinks', { mode: 'json' }).$type<Deeplink[]>(),
		/** Where the provider sends the payer back to (the project's page) */
		returnUrl: text('return_url'),
		/** After this, the sweep checks the invoice once and settles it */
		expiresAt: integer('expires_at').notNull(),
		/** Set when the sweep has checked this invoice; it is never checked twice */
		sweptAt: integer('swept_at'),
		/**
		 * QPay only: set when the one late check (about 24 h after `expiresAt`, for
		 * an invoice that ended `expired`) claimed this invoice. Never checked again.
		 */
		lateCheckedAt: integer('late_checked_at'),
		paidAt: integer('paid_at'),
		metadata: text('metadata', { mode: 'json' }).$type<Metadata>(),
		/** The lines `amount` is the sum of, when the project sent `items`; null for a plain amount */
		items: text('items', { mode: 'json' }).$type<LineItem[]>(),
		/* e-barimt: reserved for a later version, unused in v1 */
		ebarimtStatus: text('ebarimt_status'),
		ebarimtReceiptId: text('ebarimt_receipt_id'),
		ebarimtLottery: text('ebarimt_lottery'),
		ebarimtIssuedAt: integer('ebarimt_issued_at'),
		ebarimtData: text('ebarimt_data', { mode: 'json' }).$type<Record<string, unknown>>(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		// Lists and `GET /v1/invoices` (a project's invoices, newest id first).
		index('invoice_project_id_idx').on(t.projectId, t.id),
		// A reference, in one project (purchases, `?reference=`, newest id first) or all (search).
		index('invoice_reference_idx').on(t.reference, t.projectId, t.id),
		// Overview KPIs: invoices created in a period.
		index('invoice_created_idx').on(t.createdAt),
		// The sweep: pending invoices past expiresAt, not yet swept.
		index('invoice_sweep_idx').on(t.status, t.expiresAt).where(sql`${t.sweptAt} is null`),
		// The sweep's stale claims: swept but still pending. Partial (like the one above) so the
		// planner never prefers it for a plain `status = ?` without statistics.
		index('invoice_sweep_claimed_idx').on(t.status, t.sweptAt).where(sql`${t.sweptAt} is not null`),
		// The late check: expired invoices not yet late-checked.
		index('invoice_late_check_idx').on(t.status, t.expiresAt).where(sql`${t.lateCheckedAt} is null`),
		uniqueIndex('invoice_provider_invoice_uq').on(t.provider, t.providerInvoiceId),
		uniqueIndex('invoice_provider_transaction_uq').on(t.provider, t.providerTransactionId)
	]
);

/** A tokenized Bonum card. The token is encrypted and never leaves the gateway. */
export const card = sqliteTable(
	'card',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id),
		customerRef: text('customer_ref').notNull(),
		provider: text('provider', { enum: ['bonum'] })
			.notNull()
			.default('bonum'),
		/** `encrypt(card token)`; null once the card is removed (e.g. UNSUBSCRIBED) */
		tokenEnc: text('token_enc'),
		/** `5150 23** **** 4778` */
		mask: text('mask').notNull(),
		/** `2026/11` */
		expiry: text('expiry'),
		bankName: text('bank_name'),
		status: text('status', { enum: CARD_STATUSES }).notNull().default('active'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		removedAt: integer('removed_at')
	},
	(t) => [index('card_project_customer_idx').on(t.projectId, t.customerRef)]
);

/**
 * A request to save a card with no Bonum plan (`cards/tokenize/request` with
 * no `subscription`). Its id is the `transactionId` sent to Bonum, so the
 * CARD-TOKEN webhook finds it, and it becomes the id of the `card` row that
 * webhook creates.
 */
export const cardSetup = sqliteTable(
	'card_setup',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id),
		customerRef: text('customer_ref').notNull(),
		status: text('status', { enum: CARD_SETUP_STATUSES }).notNull().default('pending'),
		/** Bonum's card page, while pending */
		followUpLink: text('follow_up_link'),
		returnUrl: text('return_url').notNull(),
		/** The card this one replaces: removed when this one is saved */
		replacesCardId: text('replaces_card_id').references(() => card.id),
		/** The first payment taken with the card step (`payment.amount`); null = Bonum's 0.01 MNT check only */
		paymentAmount: integer('payment_amount'),
		paymentReference: text('payment_reference'),
		paymentItems: text('payment_items', { mode: 'json' }).$type<LineItem[]>(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [index('card_setup_project_customer_idx').on(t.projectId, t.customerRef)]
);

/** A Bonum card mandate on a plan. */
export const subscription = sqliteTable(
	'subscription',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id),
		planId: text('plan_id')
			.notNull()
			.references(() => plan.id),
		customerRef: text('customer_ref').notNull(),
		email: text('email'),
		status: text('status', { enum: SUBSCRIPTION_STATUSES }).notNull().default('pending'),
		/** Bonum `subscriptionId` (an integer at Bonum, kept as text), once CARD-TOKEN arrives */
		providerSubscriptionId: text('provider_subscription_id').unique(),
		/** Our `transactionId` sent to `cards/tokenize/request`; Bonum repeats it on every renewal */
		tokenizeTransactionId: text('tokenize_transaction_id').notNull().unique(),
		/** Our `transactionId` for an in-progress card replacement (`change/create-new-token`) */
		pendingTransactionId: text('pending_transaction_id').unique(),
		/** Bonum's checkout link for the pending tokenization or replacement */
		followUpLink: text('follow_up_link'),
		cardId: text('card_id').references(() => card.id),
		currentPeriodStart: integer('current_period_start'),
		currentPeriodEnd: integer('current_period_end'),
		/** Bonum's `nextBillingDate`; also the guard against crediting the first charge twice */
		nextBillAt: integer('next_bill_at'),
		/** The first billing date: monthly and yearly periods keep its day of month (clamped), so they never drift */
		billingAnchor: integer('billing_anchor'),
		/** When renewal reconciliation last claimed this subscription to ask Bonum about it (`reconcile.ts`) */
		reconciledAt: integer('reconciled_at'),
		cancelledAt: integer('cancelled_at'),
		returnUrl: text('return_url'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		// A customer's mandates, in one project or all (search).
		index('subscription_customer_idx').on(t.customerRef, t.projectId, t.planId),
		// Lists and `GET /v1/subscriptions`.
		index('subscription_project_id_idx').on(t.projectId, t.id),
		// Renewal reconciliation (live mandates past their billing date) and the status counts.
		index('subscription_status_bill_idx').on(t.status, t.nextBillAt),
		// Subscriptions per plan (plans tab, removing a plan).
		index('subscription_plan_idx').on(t.planId),
		index('subscription_card_idx').on(t.cardId)
	]
);

/** A charge of a saved card (Bonum purchase, or the first payment of a card step). */
export const charge = sqliteTable(
	'charge',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id),
		cardId: text('card_id')
			.notNull()
			.references(() => card.id),
		subscriptionId: text('subscription_id').references(() => subscription.id),
		amount: integer('amount').notNull(),
		/** The lines `amount` is the sum of, when the project sent `items`; null for a plain amount */
		items: text('items', { mode: 'json' }).$type<LineItem[]>(),
		reference: text('reference').notNull(),
		/** Our merchant `transactionId` sent to purchase; TOKEN-PAYMENT and reverse use it */
		providerTransactionId: text('provider_transaction_id').notNull().unique(),
		status: text('status', { enum: CHARGE_STATUSES }).notNull().default('pending'),
		/** A short machine code only; never the provider's free text */
		failureCode: text('failure_code'),
		reversedAt: integer('reversed_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		// Lists and `GET /v1/charges`.
		index('charge_project_id_idx').on(t.projectId, t.id),
		// A reference, in one project or all (search).
		index('charge_reference_idx').on(t.reference, t.projectId),
		// Charges stuck pending, and the overview's finished charges in a period.
		index('charge_status_created_idx').on(t.status, t.createdAt),
		index('charge_card_idx').on(t.cardId),
		index('charge_subscription_idx').on(t.subscriptionId)
	]
);

/**
 * Every provider payment, applied exactly once. The ledger insert and the state
 * change go in one `db.batch`; a replayed webhook hits the unique index and the
 * whole batch rolls back. Exactly one event is emitted per ledger row.
 */
export const ledger = sqliteTable(
	'ledger',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id),
		provider: text('provider', { enum: PROVIDERS }).notNull(),
		/**
		 * The provider's id for this payment: `sub-invoice:<Bonum invoiceId>` for a
		 * renewal, `sub-period:<subscriptionId>:<periodKey>` for a renewal credited
		 * by reconciliation (renamed to `sub-invoice:…` when its webhook arrives),
		 * QPay `payment_id`, …
		 */
		providerRef: text('provider_ref').notNull(),
		kind: text('kind', { enum: LEDGER_KINDS }).notNull(),
		/** The invoice, subscription or charge id */
		subjectId: text('subject_id').notNull(),
		/** Integer MNT; negative for a reversal */
		amount: integer('amount').notNull(),
		/**
		 * Renewals only: the scheduled billing date the charge pays for (ISO,
		 * `billingPeriodKey`), from the charge's own time and the subscription's
		 * billing anchor. UNIQUE per subject, so a renewal credited by
		 * reconciliation and the late webhook for the same period can never both
		 * be credited. Null for every other row (SQLite lets NULLs repeat).
		 */
		periodKey: text('period_key'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		uniqueIndex('ledger_provider_ref_uq').on(t.provider, t.providerRef),
		uniqueIndex('ledger_subject_period_uq').on(t.subjectId, t.periodKey),
		// Volume in a period (overview, usage), for one project or all.
		index('ledger_created_idx').on(t.createdAt, t.projectId),
		index('ledger_subject_idx').on(t.subjectId)
	]
);

/** Provider access tokens shared across isolates (Bonum mints are rate-limited). */
export const providerToken = sqliteTable('provider_token', {
	/** e.g. `bonum:<sha256 of base url + terminal>`; no secret in the key */
	key: text('key').primaryKey(),
	accessTokenEnc: text('access_token_enc').notNull(),
	refreshTokenEnc: text('refresh_token_enc'),
	expiresAt: integer('expires_at').notNull(),
	refreshExpiresAt: integer('refresh_expires_at'),
	updatedAt: integer('updated_at').notNull()
});

/* ------------------------------------------------------------------ *
 * Events (outbox)
 * ------------------------------------------------------------------ */

/** A fact reported to a project. Written only through `emitEvent` / `eventInserts`. */
export const event = sqliteTable(
	'event',
	{
		/** ULID; the feed (`GET /v1/events?after=`) pages by it */
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id),
		/** `invoice.paid`, … (see `events/emit.ts` `EventType`) */
		type: text('type').notNull(),
		/** The invoice, subscription or charge the event is about */
		subjectId: text('subject_id').notNull(),
		/** The payload body, as sent (see `EventData`) */
		data: text('data', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
		/**
		 * Optional guard against emitting the same fact twice, e.g. `ledger:<id>`
		 * or `invoice.expired:<invoiceId>`. Unique when set.
		 */
		dedupeKey: text('dedupe_key').unique(),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		// The feed and the events list (a project's events by id).
		index('event_project_id_idx').on(t.projectId, t.id),
		index('event_subject_idx').on(t.subjectId),
		// Events in a month (usage), counted from the index alone.
		index('event_created_idx').on(t.createdAt, t.projectId)
	]
);

/** One push of an event to its project's webhook URL, with retries. */
export const delivery = sqliteTable(
	'delivery',
	{
		id: text('id').primaryKey(),
		eventId: text('event_id')
			.notNull()
			.references(() => event.id),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id),
		status: text('status', { enum: DELIVERY_STATUSES }).notNull().default('pending'),
		attempts: integer('attempts').notNull().default(0),
		/** When the cron should try next; null once final */
		nextAttemptAt: integer('next_attempt_at'),
		/** HTTP status of the last attempt, if any */
		lastStatus: integer('last_status'),
		/** Short safe text of the last failure (e.g. `timeout`, `http_500`, `no_webhook_url`) */
		lastError: text('last_error'),
		/** The project's answer to the last attempt, truncated to 2 KB (`truncateResponseBody`) */
		lastResponseBody: text('last_response_body'),
		lastDurationMs: integer('last_duration_ms'),
		deliveredAt: integer('delivered_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		// The cron: pending deliveries due now.
		index('delivery_due_idx').on(t.status, t.nextAttemptAt),
		// Fresh deliveries (after each request), failing ones and delivery health in a recent window.
		index('delivery_status_created_idx').on(t.status, t.createdAt),
		// An event's deliveries, newest id first: "the latest delivery" is one probe.
		index('delivery_event_id_idx').on(t.eventId, t.id),
		// A project's recent deliveries (webhook tab).
		index('delivery_project_id_idx').on(t.projectId, t.id)
	]
);

export const DELIVERY_ATTEMPT_TRIGGERS = ['inline', 'cron', 'manual'] as const;
export type DeliveryAttemptTrigger = (typeof DELIVERY_ATTEMPT_TRIGGERS)[number];

/**
 * One HTTP attempt of a `delivery`, kept for the dashboard's event detail
 * (the per-attempt list: status, duration, response). `delivery.last_*` mirrors
 * the newest row. Settling without a request (no webhook URL, archived
 * project) writes no attempt. Migration: `drizzle/0001_delivery_attempts.sql`.
 */
export const deliveryAttempt = sqliteTable(
	'delivery_attempt',
	{
		id: text('id').primaryKey(),
		deliveryId: text('delivery_id')
			.notNull()
			.references(() => delivery.id),
		eventId: text('event_id')
			.notNull()
			.references(() => event.id),
		projectId: text('project_id')
			.notNull()
			.references(() => project.id),
		/** 1-based; equals `delivery.attempts` after this attempt was claimed */
		number: integer('number').notNull(),
		trigger: text('trigger', { enum: DELIVERY_ATTEMPT_TRIGGERS }).notNull(),
		/** Where it was POSTed (the project's webhook URL at the time) */
		url: text('url').notNull(),
		succeeded: integer('succeeded', { mode: 'boolean' }).notNull(),
		/** HTTP status, when the project answered */
		httpStatus: integer('http_status'),
		/** Short class on failure: `timeout`, `dns`, `tls`, `http_5xx`, … */
		error: text('error'),
		/** The `Bogts-Signature` header sent (not a secret: an HMAC of this one body) */
		signature: text('signature'),
		/** Truncated to 2 KB (`truncateResponseBody`) */
		responseBody: text('response_body'),
		durationMs: integer('duration_ms').notNull(),
		createdAt: integer('created_at').notNull()
	},
	// Written on every attempt and read only per event, so one index.
	(t) => [index('delivery_attempt_event_idx').on(t.eventId, t.number)]
);

/* ------------------------------------------------------------------ *
 * Request plumbing and the dashboard
 * ------------------------------------------------------------------ */

/** `Idempotency-Key` on project POSTs: 24 h per project (see `idempotency.ts`). */
export const idempotency = sqliteTable(
	'idempotency',
	{
		projectId: text('project_id')
			.notNull()
			.references(() => project.id),
		key: text('key').notNull(),
		/** sha256 of method, path and body: a reused key with a different request is refused */
		requestHash: text('request_hash').notNull(),
		/** HTTP status of the first response; null while that request is still running */
		status: integer('status'),
		/** The first response body (JSON text); null while running */
		response: text('response'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [primaryKey({ columns: [t.projectId, t.key] }), index('idempotency_created_idx').on(t.createdAt)]
);

/** Dashboard actions (cancel a mandate, reverse a charge, rotate a key, …). */
export const auditLog = sqliteTable(
	'audit_log',
	{
		id: text('id').primaryKey(),
		/** `access:<email>` or `password` */
		actor: text('actor').notNull(),
		/** e.g. `project.create`, `subscription.cancel` */
		action: text('action').notNull(),
		/** The id acted on */
		subject: text('subject'),
		/** Small, secret-free details */
		detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>(),
		createdAt: integer('created_at').notNull()
	},
	// A subject's entries: timelines and plan validation status.
	(t) => [index('audit_log_subject_idx').on(t.subject, t.createdAt)]
);

export const ACTIVITY_SUBJECT_TYPES = ['invoice', 'subscription', 'charge', 'card', 'provider'] as const;
export type ActivitySubjectType = (typeof ACTIVITY_SUBJECT_TYPES)[number];
export const ACTIVITY_SOURCES = ['provider', 'gateway', 'admin'] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/**
 * A timeline of what happened to a payment, subscription or charge (or to a
 * provider connection), for the dashboard: webhooks received, checks made,
 * failures. Short safe text only: never provider bodies, tokens or secrets.
 * Written through `recordActivity` (activity.ts).
 */
export const activity = sqliteTable(
	'activity',
	{
		id: text('id').primaryKey(),
		/** Null for deployment-wide entries (e.g. a provider auth failure) */
		projectId: text('project_id').references(() => project.id),
		subjectType: text('subject_type', { enum: ACTIVITY_SUBJECT_TYPES }).notNull(),
		/** The invoice, subscription or charge id; null for `provider` entries */
		subjectId: text('subject_id'),
		source: text('source', { enum: ACTIVITY_SOURCES }).notNull(),
		/** A short machine code, e.g. `bonum.card_token.failed`, `qpay.callback.unverified` */
		kind: text('kind').notNull(),
		/** Short safe text for people */
		summary: text('summary').notNull(),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		index('activity_subject_idx').on(t.subjectType, t.subjectId, t.createdAt),
		// Overview "Needs attention": findings of given kinds in the last 30 days.
		index('activity_kind_created_idx').on(t.kind, t.createdAt)
	]
);

/**
 * The company's branding, one row (`id = 'default'`): shown in the dashboard
 * and on the public pay pages. Every column is optional; with none set, the
 * pages use Bogts' own mark and accent.
 */
export const branding = sqliteTable('branding', {
	id: text('id').primaryKey(),
	companyName: text('company_name'),
	/** A `brand_logo.hash` */
	logoHash: text('logo_hash'),
	/** `#rrggbb`; the pages derive readable light and dark variants from it */
	accentColor: text('accent_color'),
	supportEmail: text('support_email'),
	supportUrl: text('support_url'),
	updatedAt: integer('updated_at').notNull()
});

export const LOGO_TYPES = ['image/png', 'image/webp', 'image/svg+xml'] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

/**
 * Uploaded logos, content-addressed: the hash is the sha-256 of the stored
 * bytes (after SVG sanitising), so `/brand/logo/<hash>` can be cached forever.
 * At most 256 KB each, base64 in D1 (no R2 binding, so the Deploy button keeps working).
 */
export const brandLogo = sqliteTable('brand_logo', {
	hash: text('hash').primaryKey(),
	contentType: text('content_type', { enum: LOGO_TYPES }).notNull(),
	/** base64 of the bytes */
	data: text('data').notNull(),
	size: integer('size').notNull(),
	createdAt: integer('created_at').notNull()
});

/** When each cron job last ran and how it went, for the dashboard's health view. */
export const cronHeartbeat = sqliteTable('cron_heartbeat', {
	/** `tick`, `deliver`, `sweep`, `late_check`, `reconcile`, `purge` */
	name: text('name').primaryKey(),
	lastRunAt: integer('last_run_at').notNull(),
	lastDurationMs: integer('last_duration_ms').notNull(),
	/** Error name only; null when the last run succeeded */
	lastError: text('last_error')
});

/** Fixed-window counters (admin login attempts). */
export const rateLimit = sqliteTable('rate_limit', {
	key: text('key').primaryKey(),
	count: integer('count').notNull(),
	windowStart: integer('window_start').notNull()
});

/* ------------------------------------------------------------------ *
 * Row types
 * ------------------------------------------------------------------ */

export type Project = typeof project.$inferSelect;
export type NewProject = typeof project.$inferInsert;
export type Plan = typeof plan.$inferSelect;
export type NewPlan = typeof plan.$inferInsert;
export type Invoice = typeof invoice.$inferSelect;
export type NewInvoice = typeof invoice.$inferInsert;
export type Card = typeof card.$inferSelect;
export type NewCard = typeof card.$inferInsert;
export type CardSetup = typeof cardSetup.$inferSelect;
export type Subscription = typeof subscription.$inferSelect;
export type NewSubscription = typeof subscription.$inferInsert;
export type Charge = typeof charge.$inferSelect;
export type NewCharge = typeof charge.$inferInsert;
export type Ledger = typeof ledger.$inferSelect;
export type NewLedger = typeof ledger.$inferInsert;
export type ProviderToken = typeof providerToken.$inferSelect;
export type EventRow = typeof event.$inferSelect;
export type Delivery = typeof delivery.$inferSelect;
export type DeliveryAttempt = typeof deliveryAttempt.$inferSelect;
export type Idempotency = typeof idempotency.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;
export type Activity = typeof activity.$inferSelect;
export type NewActivity = typeof activity.$inferInsert;
export type CronHeartbeat = typeof cronHeartbeat.$inferSelect;
export type Branding = typeof branding.$inferSelect;
export type BrandLogo = typeof brandLogo.$inferSelect;
