/**
 * Charges of a saved card (Bonum `transaction/purchase` with `X-CARD-TOKEN`),
 * and their reversal. The card is named directly (`cardId`) or through a
 * subscription (`subscriptionId`: that subscription's card).
 *
 * The charge row is written (pending) before Bonum is called, with our id as
 * the merchant `transactionId`, so a queued result (`TOKEN-PAYMENT` webhook)
 * always finds it. Outcomes of purchase:
 *  - 200: succeeded (ledger `charge:<transactionId>` + `charge.succeeded`)
 *  - 400: failed, `card_declined` (Bonum's `errorCode` is never exposed)
 *  - 201 QUEUED: queued until `TOKEN-PAYMENT`
 *  - 429 (`subscription.process.waiting`): failed, `provider_busy`
 *  - no answer (timeout, network, 5xx): stays pending, since Bonum may have charged
 */
import { and, desc, eq, inArray, lt, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { recordActivity } from '../activity';
import { ApiError, notFound } from '../api/errors';
import { eventInserts, type ChargeEventData } from '../events/emit';
import { newId } from '../ids';
import { isValidAmount } from '../money';
import {
	card as cardTable,
	charge as chargeTable,
	CHARGE_STATUSES,
	ledger,
	subscription as subTable,
	type Card,
	type Charge,
	type LineItem,
	type Project
} from '../schema';
import { BonumError, bonumCall, bonumConfigOf, providerError, unwrap } from '../providers/bonum/client';
import { nowOf, type ServiceContext } from './context';
import { priceFields, priceOf } from './items';
import { iso, ListQuery, pageOf, type ListPage } from './paging';
import { cardToken, loadCard } from './subscriptions';

export const CreateChargeInput = z.object({
	/** Send one of these: the card to charge, or a subscription whose card to charge */
	cardId: z.string().min(1).max(64).optional(),
	subscriptionId: z.string().min(1).max(64).optional(),
	/** Send `amount`, or `items` (lines that add up to it; a discount is a negative line) */
	...priceFields,
	reference: z.string().min(1).max(128)
});
export type CreateChargeInput = z.output<typeof CreateChargeInput>;

export const ChargeListQuery = ListQuery.extend({
	cardId: z.string().min(1).max(64).optional(),
	subscriptionId: z.string().min(1).max(64).optional(),
	status: z.enum(CHARGE_STATUSES).optional()
});
export type ChargeListQuery = z.output<typeof ChargeListQuery>;

export type ChargeJson = {
	id: string;
	object: 'charge';
	status: Charge['status'];
	amount: number;
	currency: 'MNT';
	reference: string;
	cardId: string;
	subscriptionId: string | null;
	items: LineItem[] | null;
	failureCode: string | null;
	createdAt: string;
};

export function chargeJson(c: Charge): ChargeJson {
	return {
		id: c.id,
		object: 'charge',
		status: c.status,
		amount: c.amount,
		currency: 'MNT',
		reference: c.reference,
		cardId: c.cardId,
		subscriptionId: c.subscriptionId,
		items: c.items ?? null,
		failureCode: c.failureCode,
		createdAt: iso(c.createdAt)!
	};
}

/** The ledger key of a charge's payment; TOKEN-PAYMENT and the purchase answer share it. */
export const chargeLedgerRef = (c: Pick<Charge, 'providerTransactionId'>) => `charge:${c.providerTransactionId}`;
const reversalLedgerRef = (c: Pick<Charge, 'providerTransactionId'>) => `charge-reverse:${c.providerTransactionId}`;

/** The `data` of a charge event. */
export function chargeEventData(c: Charge, customerRef: string, extra: Partial<ChargeEventData> = {}): ChargeEventData {
	return {
		chargeId: c.id,
		cardId: c.cardId,
		subscriptionId: c.subscriptionId,
		customerRef,
		reference: c.reference,
		amount: c.amount,
		currency: 'MNT',
		...(c.items ? { items: c.items } : {}),
		...extra
	};
}

async function eventData(ctx: ServiceContext, c: Charge, extra: Partial<ChargeEventData> = {}): Promise<ChargeEventData> {
	const card = await loadCard(ctx, c.cardId);
	return chargeEventData(c, card?.customerRef ?? '', extra);
}

async function reload(ctx: ServiceContext, id: string): Promise<Charge> {
	const [row] = await ctx.db.select().from(chargeTable).where(eq(chargeTable.id, id)).limit(1);
	if (!row) throw notFound('Charge');
	return row;
}

async function ledgerHas(ctx: ServiceContext, providerRef: string): Promise<boolean> {
	const [row] = await ctx.db
		.select({ id: ledger.id })
		.from(ledger)
		.where(and(eq(ledger.provider, 'bonum'), eq(ledger.providerRef, providerRef)))
		.limit(1);
	return !!row;
}

/**
 * Records a charge's payment exactly once: ledger row, `succeeded`, and
 * `charge.succeeded`, in one batch. Money wins over an earlier local verdict,
 * so a queued charge we had marked failed still becomes succeeded.
 */
export async function succeedCharge(ctx: ServiceContext, c: Charge): Promise<'settled' | 'duplicate'> {
	const ref = chargeLedgerRef(c);
	if (c.status === 'reversed' || (await ledgerHas(ctx, ref))) return 'duplicate';
	const now = nowOf(ctx);
	const { statements } = eventInserts(
		ctx.db,
		{ projectId: c.projectId, type: 'charge.succeeded', subjectId: c.id, data: await eventData(ctx, c) },
		now
	);
	try {
		await ctx.db.batch([
			ctx.db.insert(ledger).values({
				id: newId(),
				projectId: c.projectId,
				provider: 'bonum',
				providerRef: ref,
				kind: 'charge',
				subjectId: c.id,
				amount: c.amount,
				createdAt: now
			}),
			ctx.db
				.update(chargeTable)
				.set({ status: 'succeeded', failureCode: null, updatedAt: now })
				.where(and(eq(chargeTable.id, c.id), inArray(chargeTable.status, ['pending', 'queued', 'failed']))),
			...statements
		]);
	} catch (err) {
		if (await ledgerHas(ctx, ref)) return 'duplicate';
		throw err;
	}
	return 'settled';
}

/** Ends an unpaid charge as failed with a short code, and emits `charge.failed` once. */
export async function failCharge(ctx: ServiceContext, c: Charge, failureCode: string): Promise<'failed' | 'duplicate'> {
	if (c.status !== 'pending' && c.status !== 'queued') return 'duplicate';
	const now = nowOf(ctx);
	const dedupeKey = `charge.failed:${c.id}`;
	const { statements } = eventInserts(
		ctx.db,
		{
			projectId: c.projectId,
			type: 'charge.failed',
			subjectId: c.id,
			data: await eventData(ctx, c, { failureCode }),
			dedupeKey
		},
		now
	);
	try {
		await ctx.db.batch([
			ctx.db
				.update(chargeTable)
				.set({ status: 'failed', failureCode, updatedAt: now })
				.where(and(eq(chargeTable.id, c.id), inArray(chargeTable.status, ['pending', 'queued']))),
			...statements
		]);
	} catch (err) {
		const current = await reload(ctx, c.id);
		if (current.status !== 'pending' && current.status !== 'queued') return 'duplicate';
		throw err;
	}
	return 'failed';
}

async function note(ctx: ServiceContext, c: Charge, kind: string, summary: string, source: 'provider' | 'gateway' | 'admin' = 'provider') {
	await recordActivity(ctx.db, { projectId: c.projectId, subjectType: 'charge', subjectId: c.id, source, kind, summary }, nowOf(ctx));
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

export async function createCharge(ctx: ServiceContext, project: Project, input: CreateChargeInput): Promise<ChargeJson> {
	bonumConfigOf(ctx);
	if ((input.cardId === undefined) === (input.subscriptionId === undefined)) {
		throw new ApiError(400, 'invalid_request', 'cardId: send either cardId or subscriptionId');
	}
	const price = priceOf(input);
	if (!isValidAmount(price.amount)) throw new ApiError(400, 'invalid_request', 'amount: must be a positive whole number of MNT');

	let card: Card | null;
	let subscriptionId: string | null = null;
	if (input.subscriptionId !== undefined) {
		const [sub] = await ctx.db
			.select()
			.from(subTable)
			.where(and(eq(subTable.id, input.subscriptionId), eq(subTable.projectId, project.id)))
			.limit(1);
		if (!sub) throw notFound('Subscription');
		if (sub.status !== 'active' && sub.status !== 'past_due') {
			throw new ApiError(409, 'conflict', `The card of a ${sub.status} subscription cannot be charged`);
		}
		subscriptionId = sub.id;
		card = await loadCard(ctx, sub.cardId);
		if (!card || card.status !== 'active' || !card.tokenEnc) throw new ApiError(409, 'conflict', 'The subscription has no usable card');
	} else {
		card = await loadCard(ctx, input.cardId!);
		if (!card || card.projectId !== project.id) throw notFound('Card');
		if (card.status !== 'active' || !card.tokenEnc) throw new ApiError(409, 'conflict', `A ${card.status} card cannot be charged`);
	}
	return chargeJson(await chargeCard(ctx, { card, subscriptionId, ...price, reference: input.reference }));
}

/**
 * Charges an active card once and returns the charge as it stands: `succeeded`,
 * `failed`, `queued` or `pending` (see the top of this file). The caller has
 * checked that the card is the project's and has a token.
 */
export async function chargeCard(
	ctx: ServiceContext,
	input: { card: Card; subscriptionId: string | null; amount: number; items: LineItem[] | null; reference: string }
): Promise<Charge> {
	const { card } = input;
	const token = await cardToken(ctx, card);
	if (!token) throw new ApiError(409, 'conflict', `A ${card.status} card cannot be charged`);

	const now = nowOf(ctx);
	const id = newId();
	const row: Charge = {
		id,
		projectId: card.projectId,
		cardId: card.id,
		subscriptionId: input.subscriptionId,
		amount: input.amount,
		items: input.items,
		reference: input.reference,
		providerTransactionId: id,
		status: 'pending',
		failureCode: null,
		reversedAt: null,
		createdAt: now,
		updatedAt: now
	};
	await ctx.db.insert(chargeTable).values(row);

	let status: number;
	let body: unknown;
	try {
		({ status, body } = await bonumCall(ctx, 'purchase', '/mpay-service/merchant/transaction/purchase', {
			method: 'POST',
			body: { amount: input.amount, currency: 'MNT', transactionId: id },
			cardToken: token
		}));
	} catch (err) {
		if (!(err instanceof BonumError)) throw err;
		if (err.operation === 'purchase') {
			// The request may have reached Bonum: the outcome is unknown, so the charge
			// stays pending (a TOKEN-PAYMENT may still settle it). Never retry blindly.
			await note(ctx, row, 'bonum.purchase.unknown', `No answer from Bonum (${err.code}); the outcome is unknown`);
			return reload(ctx, id);
		}
		// Auth failed before the purchase was sent: nothing was charged.
		await note(ctx, row, 'bonum.purchase.not_sent', `Bonum could not be reached (${err.code}); nothing was charged`);
		await failCharge(ctx, row, 'provider_unavailable');
		return reload(ctx, id);
	}

	const data = unwrap(body);
	const outcome = typeof data.status === 'string' ? data.status.toUpperCase() : '';
	if (status === 201 || outcome === 'QUEUED') {
		await ctx.db
			.update(chargeTable)
			.set({ status: 'queued', updatedAt: nowOf(ctx) })
			.where(and(eq(chargeTable.id, id), eq(chargeTable.status, 'pending')));
		await note(ctx, row, 'bonum.purchase.queued', 'Bonum queued the payment; the result comes by webhook');
	} else if (status >= 200 && status < 300 && outcome !== 'FAILED') {
		await succeedCharge(ctx, row);
		await note(ctx, row, 'bonum.purchase.succeeded', 'Bonum charged the card');
	} else if (status === 400 || (status >= 200 && status < 300)) {
		await failCharge(ctx, row, 'card_declined');
		await note(ctx, row, 'bonum.purchase.declined', 'The card was declined');
	} else if (status === 429) {
		await failCharge(ctx, row, 'provider_busy');
		await note(ctx, row, 'bonum.purchase.busy', 'Bonum was busy with this card; nothing was charged');
	} else if (status >= 500) {
		await note(ctx, row, 'bonum.purchase.unknown', `Bonum answered HTTP ${status}; the outcome is unknown`);
	} else {
		await failCharge(ctx, row, 'provider_rejected');
		await note(ctx, row, 'bonum.purchase.rejected', `Bonum refused the payment (HTTP ${status})`);
	}
	return reload(ctx, id);
}

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

async function loadOwned(ctx: ServiceContext, projectId: string, id: string): Promise<Charge> {
	const [row] = await ctx.db
		.select()
		.from(chargeTable)
		.where(and(eq(chargeTable.id, id), eq(chargeTable.projectId, projectId)))
		.limit(1);
	if (!row) throw notFound('Charge');
	return row;
}

export async function getCharge(ctx: ServiceContext, projectId: string, id: string): Promise<ChargeJson> {
	return chargeJson(await loadOwned(ctx, projectId, id));
}

export async function listCharges(ctx: ServiceContext, projectId: string, q: ChargeListQuery): Promise<ListPage<ChargeJson>> {
	const where: SQL[] = [eq(chargeTable.projectId, projectId)];
	if (q.cursor) where.push(lt(chargeTable.id, q.cursor));
	if (q.cardId) where.push(eq(chargeTable.cardId, q.cardId));
	if (q.subscriptionId) where.push(eq(chargeTable.subscriptionId, q.subscriptionId));
	if (q.status) where.push(eq(chargeTable.status, q.status));
	const rows = await ctx.db
		.select()
		.from(chargeTable)
		.where(and(...where))
		.orderBy(desc(chargeTable.id))
		.limit(q.limit + 1);
	return pageOf(rows, q.limit, chargeJson);
}

/* ------------------------------------------------------------------ *
 * Reverse
 * ------------------------------------------------------------------ */

/**
 * Reverses a succeeded charge (`DELETE /transaction/reverse/:transactionId`):
 * a negative ledger row, `reversed`, and `charge.reversed`, in one batch.
 * Reversing a reversed charge is a no-op.
 */
export async function reverseCharge(
	ctx: ServiceContext,
	projectId: string,
	id: string,
	actor?: string
): Promise<ChargeJson> {
	bonumConfigOf(ctx);
	const c = await loadOwned(ctx, projectId, id);
	if (c.status === 'reversed') return chargeJson(c);
	if (c.status !== 'succeeded') throw new ApiError(409, 'conflict', `A ${c.status} charge cannot be reversed`);
	const card = await ctx.db.select().from(cardTable).where(eq(cardTable.id, c.cardId)).limit(1);
	const token = card[0]?.tokenEnc ? await cardToken(ctx, { ...card[0], status: 'active' }) : null;
	if (!token) throw new ApiError(409, 'conflict', 'The card was removed, so Bonum cannot reverse this charge');

	let status: number;
	try {
		({ status } = await bonumCall(
			ctx,
			'purchase/reverse',
			`/mpay-service/merchant/transaction/reverse/${encodeURIComponent(c.providerTransactionId)}`,
			{ method: 'DELETE', cardToken: token }
		));
	} catch (err) {
		throw providerError(err);
	}
	if (status < 200 || status >= 300) {
		await note(ctx, c, 'bonum.reverse.failed', `Bonum refused the reversal (HTTP ${status})`);
		throw new ApiError(502, 'provider_error', 'Bonum did not reverse the charge. Try again.');
	}

	const now = nowOf(ctx);
	const ref = reversalLedgerRef(c);
	const { statements } = eventInserts(
		ctx.db,
		{ projectId: c.projectId, type: 'charge.reversed', subjectId: c.id, data: await eventData(ctx, c) },
		now
	);
	try {
		await ctx.db.batch([
			ctx.db.insert(ledger).values({
				id: newId(),
				projectId: c.projectId,
				provider: 'bonum',
				providerRef: ref,
				kind: 'charge',
				subjectId: c.id,
				amount: -c.amount,
				createdAt: now
			}),
			ctx.db
				.update(chargeTable)
				.set({ status: 'reversed', reversedAt: now, updatedAt: now })
				.where(and(eq(chargeTable.id, c.id), eq(chargeTable.status, 'succeeded'))),
			...statements
		]);
	} catch (err) {
		if (!(await ledgerHas(ctx, ref))) throw err;
	}
	await note(
		ctx,
		c,
		actor ? 'admin.charge.reverse' : 'charge.reverse',
		actor ? 'Reversed from the dashboard' : 'Reversed by the project',
		actor ? 'admin' : 'gateway'
	);
	return chargeJson(await reload(ctx, c.id));
}
