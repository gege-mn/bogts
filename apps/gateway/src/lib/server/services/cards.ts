/**
 * Saved cards with no Bonum plan: `cards/tokenize/request` without a
 * `subscription`, so Bonum only stores the card and Bogts decides when and how
 * much to charge it (`services/charges.ts`).
 *
 * Saving: insert a `card_setup` row, ask Bonum for its card page with the
 * row's id as `transactionId`, and hand back the link. The card itself is
 * created by the CARD-TOKEN webhook (`saveCard`, called from
 * `providers/bonum/webhook.ts`) under the same id, so the id a project gets
 * at once is the card's id for good. A first payment (`payment`) is taken by
 * Bonum in the same step and becomes an ordinary succeeded charge, whether or
 * not Bonum's message repeats the amount; without one Bonum takes its
 * 0.01 MNT check, which is not money.
 *
 * A card step the customer never finishes is ended after `CARD_STEP_TTL_MS`
 * (`expireCardSteps`, from the cron sweep).
 *
 * A customer can have several cards. Replacing one saves a new card (a new
 * id) and removes the old one only once the new one is in. The token is
 * encrypted at rest and never leaves the gateway.
 */
import { and, asc, desc, eq, inArray, lt, lte, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { recordActivity } from '../activity';
import { ApiError, notFound } from '../api/errors';
import { encrypt } from '../crypto';
import type { DB } from '../db';
import type { Config } from '../env';
import { eventInserts, type CardEventData } from '../events/emit';
import { newId } from '../ids';
import { isValidAmount } from '../money';
import {
	card as cardTable,
	cardSetup,
	charge as chargeTable,
	CARD_STATUSES,
	event,
	ledger,
	subscription as subTable,
	type Card,
	type CardSetup,
	type Charge,
	type Project
} from '../schema';
import { BonumError, bonumConfigOf, bonumRequest, providerError, unwrap } from '../providers/bonum/client';
import { bonumItem, checkedFollowUpLink } from '../providers/bonum/util';
import { chargeEventData, chargeLedgerRef } from './charges';
import { nowOf, type ServiceContext } from './context';
import { priceFields, priceOf } from './items';
import { iso, ListQuery, pageOf, type ListPage } from './paging';
import { ReturnUrl } from './subscriptions';

const Payment = z.object({
	/** Send `amount`, or `items` (lines that add up to it; a discount is a negative line) */
	...priceFields,
	reference: z.string().min(1).max(128)
});

export const CreateCardInput = z.object({
	customerRef: z.string().min(1).max(128),
	returnUrl: ReturnUrl,
	/** A first payment taken while the card is saved; without it nothing is charged */
	payment: Payment.optional()
});
export type CreateCardInput = z.output<typeof CreateCardInput>;

export const ReplaceCardInput = z.object({ returnUrl: ReturnUrl });
export type ReplaceCardInput = z.output<typeof ReplaceCardInput>;

export const CardListQuery = ListQuery.extend({
	customerRef: z.string().min(1).max(128).optional(),
	status: z.enum(CARD_STATUSES).optional()
});
export type CardListQuery = z.output<typeof CardListQuery>;

export type CardJson = {
	id: string;
	object: 'card';
	customerRef: string;
	/** `pending` and `failed` are the card step; `active` and `removed` a saved card */
	status: 'pending' | 'failed' | Card['status'];
	/** Bonum's card page, while `pending` */
	redirectUrl: string | null;
	mask: string | null;
	expiry: string | null;
	bank: string | null;
	createdAt: string;
};

export function cardJson(c: Card): CardJson {
	return {
		id: c.id,
		object: 'card',
		customerRef: c.customerRef,
		status: c.status,
		redirectUrl: null,
		mask: c.mask,
		expiry: c.expiry,
		bank: c.bankName,
		createdAt: iso(c.createdAt)!
	};
}

/** A card step that has not produced a card (yet). */
function setupJson(s: CardSetup): CardJson {
	const pending = s.status === 'pending';
	return {
		id: s.id,
		object: 'card',
		customerRef: s.customerRef,
		status: pending ? 'pending' : 'failed',
		redirectUrl: pending ? s.followUpLink : null,
		mask: null,
		expiry: null,
		bank: null,
		createdAt: iso(s.createdAt)!
	};
}

async function eventExists(ctx: ServiceContext, dedupeKey: string): Promise<boolean> {
	const [row] = await ctx.db.select({ id: event.id }).from(event).where(eq(event.dedupeKey, dedupeKey)).limit(1);
	return !!row;
}

async function note(
	ctx: ServiceContext,
	projectId: string,
	cardId: string,
	kind: string,
	summary: string,
	source: 'provider' | 'gateway' | 'admin' = 'provider'
) {
	await recordActivity(ctx.db, { projectId, subjectType: 'card', subjectId: cardId, source, kind, summary }, nowOf(ctx));
}

async function loadOwnedCard(ctx: ServiceContext, projectId: string, id: string): Promise<Card | undefined> {
	const [row] = await ctx.db
		.select()
		.from(cardTable)
		.where(and(eq(cardTable.id, id), eq(cardTable.projectId, projectId)))
		.limit(1);
	return row;
}

async function loadOwnedSetup(ctx: ServiceContext, projectId: string, id: string): Promise<CardSetup | undefined> {
	const [row] = await ctx.db
		.select()
		.from(cardSetup)
		.where(and(eq(cardSetup.id, id), eq(cardSetup.projectId, projectId)))
		.limit(1);
	return row;
}

/** The live Bonum-plan subscription that bills this card, if any: Bonum owns that card's schedule. */
async function mandateOn(ctx: ServiceContext, cardId: string): Promise<string | undefined> {
	const [row] = await ctx.db
		.select({ id: subTable.id })
		.from(subTable)
		.where(and(eq(subTable.cardId, cardId), inArray(subTable.status, ['pending', 'active', 'past_due'])))
		.limit(1);
	return row?.id;
}

/* ------------------------------------------------------------------ *
 * Save
 * ------------------------------------------------------------------ */

/** `POST /v1/cards`: starts a card step and returns the pending card with Bonum's `redirectUrl`. */
export async function createCard(ctx: ServiceContext, project: Project, input: CreateCardInput): Promise<CardJson> {
	return startSetup(ctx, project.id, input, null);
}

/**
 * `POST /v1/cards/:id/replace`: starts a card step for the same customer. The
 * old card stays usable until the new one is saved, and is removed then; if
 * the customer gives up, nothing changes. A card billed by a Bonum-plan
 * subscription is replaced through that subscription instead.
 */
export async function replaceSavedCard(
	ctx: ServiceContext,
	projectId: string,
	id: string,
	input: ReplaceCardInput
): Promise<CardJson> {
	const old = await loadOwnedCard(ctx, projectId, id);
	if (!old) throw notFound('Card');
	if (old.status !== 'active') throw new ApiError(409, 'conflict', `A ${old.status} card cannot be replaced`);
	const mandate = await mandateOn(ctx, old.id);
	if (mandate) {
		throw new ApiError(409, 'conflict', `Subscription ${mandate} bills this card; replace it with POST /v1/subscriptions/${mandate}/card`);
	}
	return startSetup(ctx, projectId, { customerRef: old.customerRef, returnUrl: input.returnUrl }, old.id);
}

async function startSetup(
	ctx: ServiceContext,
	projectId: string,
	input: CreateCardInput,
	replacesCardId: string | null
): Promise<CardJson> {
	bonumConfigOf(ctx);
	const price = input.payment ? priceOf(input.payment, 'payment.') : null;
	if (price && !isValidAmount(price.amount)) {
		throw new ApiError(400, 'invalid_request', 'payment.amount: must be a positive whole number of MNT');
	}
	const now = nowOf(ctx);
	const id = newId();
	const row: CardSetup = {
		id,
		projectId,
		customerRef: input.customerRef,
		status: 'pending',
		followUpLink: null,
		returnUrl: input.returnUrl,
		replacesCardId,
		paymentAmount: price?.amount ?? null,
		paymentReference: input.payment?.reference ?? null,
		paymentItems: price?.items ?? null,
		createdAt: now,
		updatedAt: now
	};
	await ctx.db.insert(cardSetup).values(row);

	let followUpLink: string;
	try {
		const body = await bonumRequest(ctx, 'cards/tokenize', '/mpay-service/merchant/cards/tokenize/request', {
			method: 'POST',
			body: {
				callback: `${ctx.config.publicOrigin}/return/c/${id}`,
				transactionId: id,
				// No `subscription`: a plain card token. No `payment`: Bonum's 0.01 MNT check.
				...(price
					? {
							payment: { amount: price.amount },
							// Bonum's page shows one line; its items can't carry a negative (discount) line.
							items: [bonumItem(price.items?.[0]?.label ?? input.payment!.reference, price.amount, { image: true })]
						}
					: {})
			}
		});
		followUpLink = checkedFollowUpLink(unwrap(body).followUpLink, 'cards/tokenize');
	} catch (err) {
		await failSetup(ctx, row);
		if (err instanceof BonumError) await note(ctx, projectId, id, 'bonum.tokenize.failed', `Bonum refused the card step (${err.code})`);
		throw providerError(err);
	}
	await ctx.db.update(cardSetup).set({ followUpLink, updatedAt: now }).where(eq(cardSetup.id, id));
	return setupJson({ ...row, followUpLink });
}

/**
 * Ends a pending card step as failed and emits `card.failed` once. Returns
 * false when it was not pending (already saved, or already failed).
 */
export async function failSetup(ctx: ServiceContext, setup: CardSetup): Promise<boolean> {
	if (setup.status !== 'pending') return false;
	const now = nowOf(ctx);
	const dedupeKey = `card.failed:${setup.id}`;
	const data: CardEventData = { cardId: setup.id, customerRef: setup.customerRef, reason: 'checkout_failed' };
	const { statements } = eventInserts(
		ctx.db,
		{ projectId: setup.projectId, type: 'card.failed', subjectId: setup.id, data, dedupeKey },
		now
	);
	try {
		await ctx.db.batch([
			ctx.db
				.update(cardSetup)
				.set({ status: 'failed', followUpLink: null, updatedAt: now })
				.where(and(eq(cardSetup.id, setup.id), eq(cardSetup.status, 'pending'))),
			...statements
		]);
	} catch (err) {
		if (await eventExists(ctx, dedupeKey)) return false;
		throw err;
	}
	return true;
}

/**
 * A card step still `pending` this long after it was started is ended as
 * failed (`card.failed`). If Bonum reports the card afterwards it is saved all
 * the same (`saveCard`).
 */
export const CARD_STEP_TTL_MS = 24 * 60 * 60 * 1000;
export const CARD_STEP_BATCH = 100;

/** Ends abandoned card steps (from the cron sweep). Returns how many it ended. */
export async function expireCardSteps(db: DB, config: Config, now: number): Promise<number> {
	const ctx: ServiceContext = { db, config, now };
	const due = await db
		.select()
		.from(cardSetup)
		.where(and(eq(cardSetup.status, 'pending'), lte(cardSetup.createdAt, now - CARD_STEP_TTL_MS)))
		.orderBy(asc(cardSetup.createdAt))
		.limit(CARD_STEP_BATCH);
	let ended = 0;
	for (const setup of due) {
		if (!(await failSetup(ctx, setup))) continue;
		ended++;
		await note(ctx, setup.projectId, setup.id, 'card.step_expired', 'The customer did not finish the card step in time', 'gateway');
	}
	return ended;
}

/** What Bonum's CARD-TOKEN said about the card it saved. */
export type SavedCardDetails = {
	token: string;
	mask: string;
	expiry: string | null;
	bankName: string | null;
	/** Integer MNT Bonum took with the card step; 0 for the 0.01 MNT check or none */
	paidAmount: number;
	/** Bonum reported no payable amount, so `paidAmount` is the amount the step asked for */
	amountAssumed?: boolean;
};

/**
 * A card step succeeded: in one batch, the card (under the step's id), the
 * removal of the card it replaces, the first payment as a succeeded charge
 * with its ledger row, and the events (`card.saved` or `card.replaced`, and
 * `charge.succeeded`). A step that was given up on (`failed`) still saves the
 * card when Bonum reports it later, since Bonum may have taken the payment.
 * A replay is a no-op.
 */
export async function saveCard(ctx: ServiceContext, setup: CardSetup, details: SavedCardDetails): Promise<'saved' | 'duplicate'> {
	if (setup.status === 'completed') return 'duplicate';
	const now = nowOf(ctx);
	const paid = details.paidAmount > 0;
	// The lines describe the amount the project asked for; they are kept only when Bonum took exactly that.
	const asAsked = paid && details.paidAmount === setup.paymentAmount;
	const charge: Charge | null = paid
		? {
				id: newId(),
				projectId: setup.projectId,
				cardId: setup.id,
				subscriptionId: null,
				amount: details.paidAmount,
				items: asAsked ? setup.paymentItems : null,
				reference: setup.paymentReference ?? setup.id,
				// The tokenization id is the merchant transaction id of this payment at Bonum.
				providerTransactionId: setup.id,
				status: 'succeeded',
				failureCode: null,
				reversedAt: null,
				createdAt: now,
				updatedAt: now
			}
		: null;

	const replaced = setup.replacesCardId;
	const dedupeKey = `card.saved:${setup.id}`;
	const data: CardEventData = {
		cardId: setup.id,
		customerRef: setup.customerRef,
		cardMask: details.mask,
		...(replaced ? { replacesCardId: replaced } : {}),
		...(charge ? { chargeId: charge.id } : {})
	};
	const saved = eventInserts(
		ctx.db,
		{ projectId: setup.projectId, type: replaced ? 'card.replaced' : 'card.saved', subjectId: setup.id, data, dedupeKey },
		now
	);
	const charged = charge
		? eventInserts(
				ctx.db,
				{
					projectId: setup.projectId,
					type: 'charge.succeeded',
					subjectId: charge.id,
					data: chargeEventData(charge, setup.customerRef)
				},
				now
			)
		: null;
	try {
		await ctx.db.batch([
			ctx.db.insert(cardTable).values({
				id: setup.id,
				projectId: setup.projectId,
				customerRef: setup.customerRef,
				provider: 'bonum',
				tokenEnc: await encrypt(details.token, ctx.config.encryptionKey),
				mask: details.mask,
				expiry: details.expiry,
				bankName: details.bankName,
				status: 'active',
				createdAt: now,
				updatedAt: now
			}),
			ctx.db
				.update(cardSetup)
				.set({ status: 'completed', followUpLink: null, updatedAt: now })
				.where(eq(cardSetup.id, setup.id)),
			...(replaced
				? [
						ctx.db
							.update(cardTable)
							.set({ status: 'removed', tokenEnc: null, removedAt: now, updatedAt: now })
							.where(and(eq(cardTable.id, replaced), eq(cardTable.status, 'active')))
					]
				: []),
			...(charge
				? [
						ctx.db.insert(chargeTable).values(charge),
						ctx.db.insert(ledger).values({
							id: newId(),
							projectId: setup.projectId,
							provider: 'bonum',
							providerRef: chargeLedgerRef(charge),
							kind: 'charge',
							subjectId: charge.id,
							amount: charge.amount,
							createdAt: now
						}),
						...charged!.statements
					]
				: []),
			...saved.statements
		]);
	} catch (err) {
		if (await eventExists(ctx, dedupeKey)) return 'duplicate';
		throw err;
	}

	await note(
		ctx,
		setup.projectId,
		setup.id,
		'bonum.card_token.saved',
		paid ? `Card saved and a first payment of ${details.paidAmount} MNT taken` : 'Card saved'
	);
	if (details.amountAssumed) {
		await note(
			ctx,
			setup.projectId,
			setup.id,
			'bonum.card_token.amount_assumed',
			`Bonum did not report the first payment's amount; recorded the ${details.paidAmount} MNT asked for`
		);
	} else if (setup.paymentAmount !== null && details.paidAmount !== setup.paymentAmount) {
		await note(
			ctx,
			setup.projectId,
			setup.id,
			'bonum.card_token.amount_mismatch',
			`The first payment was ${details.paidAmount} MNT, not the ${setup.paymentAmount} MNT asked for`
		);
	}
	return 'saved';
}

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

/** A saved card, or a card step that has not produced one. */
export async function getCard(ctx: ServiceContext, projectId: string, id: string): Promise<CardJson> {
	const card = await loadOwnedCard(ctx, projectId, id);
	if (card) return cardJson(card);
	const setup = await loadOwnedSetup(ctx, projectId, id);
	if (!setup) throw notFound('Card');
	return setupJson(setup);
}

/** Saved cards, newest first. A card step still waiting for the customer is not listed; read it by id. */
export async function listCards(ctx: ServiceContext, projectId: string, q: CardListQuery): Promise<ListPage<CardJson>> {
	const where: SQL[] = [eq(cardTable.projectId, projectId)];
	if (q.cursor) where.push(lt(cardTable.id, q.cursor));
	if (q.customerRef) where.push(eq(cardTable.customerRef, q.customerRef));
	if (q.status) where.push(eq(cardTable.status, q.status));
	const rows = await ctx.db
		.select()
		.from(cardTable)
		.where(and(...where))
		.orderBy(desc(cardTable.id))
		.limit(q.limit + 1);
	return pageOf(rows, q.limit, cardJson);
}

/* ------------------------------------------------------------------ *
 * Remove
 * ------------------------------------------------------------------ */

/**
 * `DELETE /v1/cards/:id`: drops the token and emits `card.removed` once.
 * Bonum has no documented endpoint that deletes a plain card token, so this is
 * local: without the token the card can never be charged again from here.
 * Removing a removed card is a no-op. A card billed by a live Bonum-plan
 * subscription is refused: cancel the subscription, which removes its card.
 */
export async function removeCard(ctx: ServiceContext, projectId: string, id: string, actor?: string): Promise<CardJson> {
	const card = await loadOwnedCard(ctx, projectId, id);
	if (!card) {
		if (await loadOwnedSetup(ctx, projectId, id)) throw new ApiError(409, 'conflict', 'This card has not been saved');
		throw notFound('Card');
	}
	if (card.status === 'removed') return cardJson(card);
	const mandate = await mandateOn(ctx, card.id);
	if (mandate) throw new ApiError(409, 'conflict', `Subscription ${mandate} bills this card; cancel it instead`);

	const now = nowOf(ctx);
	const dedupeKey = `card.removed:${card.id}`;
	const data: CardEventData = {
		cardId: card.id,
		customerRef: card.customerRef,
		reason: actor ? 'removed_by_admin' : 'removed_by_project'
	};
	const { statements } = eventInserts(
		ctx.db,
		{ projectId: card.projectId, type: 'card.removed', subjectId: card.id, data, dedupeKey },
		now
	);
	try {
		await ctx.db.batch([
			ctx.db
				.update(cardTable)
				.set({ status: 'removed', tokenEnc: null, removedAt: now, updatedAt: now })
				.where(and(eq(cardTable.id, card.id), eq(cardTable.status, 'active'))),
			...statements
		]);
	} catch (err) {
		if (!(await eventExists(ctx, dedupeKey))) throw err;
	}
	await note(
		ctx,
		projectId,
		card.id,
		actor ? 'admin.card.remove' : 'card.remove',
		actor ? 'Removed from the dashboard' : 'Removed by the project',
		actor ? 'admin' : 'gateway'
	);
	return cardJson((await loadOwnedCard(ctx, projectId, id))!);
}
