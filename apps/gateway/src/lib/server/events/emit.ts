/**
 * The event outbox: the only way anything tells a project about a payment.
 *
 * Providers and services call `emitEvent` (or splice `eventInserts` into their
 * own `db.batch`, so the event is written atomically with the ledger row and
 * the state change). They never deliver: `events/deliver.ts` does, inline via
 * `waitUntil` and from the every-minute cron.
 *
 * Every event gets exactly one `delivery` row, even when the project has no
 * webhook URL: the deliverer settles those (`last_error = 'no_webhook_url'`),
 * and the dashboard can re-deliver once a URL is set.
 */
import type { BatchItem, DB } from '../db';
import { newId } from '../ids';
import { delivery, event, type LineItem } from '../schema';

export const EVENT_TYPES = [
	'invoice.paid',
	'invoice.expired',
	'invoice.failed',
	'subscription.active',
	'subscription.renewed',
	'subscription.payment_failed',
	'subscription.cancelled',
	'subscription.card_changed',
	'charge.succeeded',
	'charge.failed',
	'charge.reversed',
	'card.saved',
	'card.failed',
	'card.replaced',
	'card.removed'
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type Period = { start: number; end: number };

export interface InvoiceEventData {
	invoiceId: string;
	provider: 'qpay' | 'bonum';
	reference: string;
	amount: number;
	currency: 'MNT';
	/** invoice.paid */
	paidAt?: number;
	metadata?: Record<string, string> | null;
	/** The lines the amount is the sum of, when the invoice was created with `items` */
	items?: LineItem[];
	/**
	 * invoice.paid only: another invoice of the project with the same
	 * `reference` was paid first (this is that invoice's id). The money moved
	 * twice for one purchase: refund one of them.
	 */
	duplicateOfInvoiceId?: string;
}

export interface SubscriptionEventData {
	subscriptionId: string;
	/** The plan key */
	plan: string;
	customerRef: string;
	/** The amount charged (renewed / active with a first charge); absent otherwise */
	amount?: number;
	currency: 'MNT';
	period?: Period;
	nextBillAt?: number | null;
	/**
	 * subscription.cancelled: who ended it (`provider_cancelled`: reconciliation
	 * found it ended at Bonum). subscription.payment_failed: `payment_failed`,
	 * `checkout_failed` or `renewal_missing` (no renewal arrived for the period).
	 */
	reason?:
		| 'cancelled_by_project'
		| 'cancelled_by_admin'
		| 'retries_exhausted'
		| 'provider_cancelled'
		| 'payment_failed'
		| 'checkout_failed'
		| 'renewal_missing'
		| (string & {});
	/** subscription.card_changed / active: the card's display mask */
	cardMask?: string;
}

export interface ChargeEventData {
	chargeId: string;
	cardId: string;
	subscriptionId?: string | null;
	customerRef: string;
	reference: string;
	amount: number;
	currency: 'MNT';
	/** The lines the amount is the sum of, when the charge was created with `items` */
	items?: LineItem[];
	/** charge.failed: a short machine code, never provider text */
	failureCode?: string | null;
}

export interface CardEventData {
	cardId: string;
	customerRef: string;
	/** card.saved / card.replaced: the card's display mask */
	cardMask?: string;
	/** card.replaced: the card this one took the place of (now removed) */
	replacesCardId?: string;
	/** card.saved: the charge of the first payment, when one was taken */
	chargeId?: string;
	/** card.failed: `checkout_failed`. card.removed: `removed_by_project` or `removed_by_admin`. */
	reason?: string;
}

/** The `data` of each event type. */
export interface EventDataMap {
	'invoice.paid': InvoiceEventData;
	'invoice.expired': InvoiceEventData;
	'invoice.failed': InvoiceEventData;
	'subscription.active': SubscriptionEventData;
	'subscription.renewed': SubscriptionEventData;
	'subscription.payment_failed': SubscriptionEventData;
	'subscription.cancelled': SubscriptionEventData;
	'subscription.card_changed': SubscriptionEventData;
	'charge.succeeded': ChargeEventData;
	'charge.failed': ChargeEventData;
	'charge.reversed': ChargeEventData;
	'card.saved': CardEventData;
	'card.failed': CardEventData;
	'card.replaced': CardEventData;
	'card.removed': CardEventData;
}

export interface GatewayEvent<T extends EventType = EventType> {
	id: string;
	projectId: string;
	type: T;
	subjectId: string;
	data: EventDataMap[T];
	createdAt: number;
}

export type EmittedEvent<T extends EventType = EventType> = GatewayEvent<T> & { deliveryId: string };

export interface EmitInput<T extends EventType> {
	projectId: string;
	type: T;
	/** The invoice, subscription, charge or card id */
	subjectId: string;
	data: EventDataMap[T];
	/**
	 * Optional: a key that makes a second emit of the same fact fail (unique),
	 * e.g. `ledger:<ledgerId>` or `invoice.expired:<invoiceId>`.
	 */
	dedupeKey?: string;
}

/**
 * The inline attempt (`waitUntil`) gets this long before the cron may also pick
 * the delivery up, so the two rarely race. Delivery is at least once either way.
 */
export const INLINE_DELIVERY_GRACE_MS = 60_000;

/**
 * The two inserts for an event (event + its delivery), for a caller to put in
 * its own `db.batch` next to the ledger row and state change:
 *
 * ```ts
 * const e = eventInserts(db, { projectId, type: 'invoice.paid', subjectId, data });
 * await db.batch([insertLedger, updateInvoice, ...e.statements]);
 * ctx.waitUntil(deliver(e.deliveryId));
 * ```
 */
export function eventInserts<T extends EventType>(
	db: DB,
	input: EmitInput<T>,
	now = Date.now()
): { event: GatewayEvent<T>; deliveryId: string; statements: [BatchItem, BatchItem] } {
	const e: GatewayEvent<T> = {
		id: newId(),
		projectId: input.projectId,
		type: input.type,
		subjectId: input.subjectId,
		data: input.data,
		createdAt: now
	};
	const deliveryId = newId();
	const insertEvent = db.insert(event).values({
		id: e.id,
		projectId: e.projectId,
		type: e.type,
		subjectId: e.subjectId,
		data: e.data as unknown as Record<string, unknown>,
		dedupeKey: input.dedupeKey ?? null,
		createdAt: now
	});
	const insertDelivery = db.insert(delivery).values({
		id: deliveryId,
		eventId: e.id,
		projectId: e.projectId,
		status: 'pending',
		attempts: 0,
		nextAttemptAt: now + INLINE_DELIVERY_GRACE_MS,
		createdAt: now,
		updatedAt: now
	});
	return { event: e, deliveryId, statements: [insertEvent, insertDelivery] };
}

/** Writes an event and its delivery row atomically and returns the event. */
export async function emitEvent<T extends EventType>(
	db: DB,
	input: EmitInput<T>,
	opts: { now?: number } = {}
): Promise<EmittedEvent<T>> {
	const { event: e, deliveryId, statements } = eventInserts(db, input, opts.now);
	await db.batch(statements);
	return { ...e, deliveryId };
}
