/**
 * Bonum webhooks (already checksum-verified and parsed by `/hooks/bonum`).
 *
 *  - CARD-TOKEN: a tokenization finished. Matched by `transactionId` to a
 *    subscription's checkout (activate, and credit the `payNow` first charge),
 *    to a pending card replacement (switch cards; the 0.01 MNT verification
 *    charge is not a payment), or to a plan-less card step (`card_setup`: save
 *    the card, and record its first payment as a charge).
 *  - SUBSCRIPTION-PAYMENT: a renewal. The ledger key is `sub-invoice:<invoiceId>`,
 *    NEVER the `transactionId`, which is the tokenization id and is the same on
 *    every renewal (docs/providers/bonum-pitfalls.md #1). The row also carries the billing
 *    period the charge pays for (`periodKey`, UNIQUE per subscription), so a
 *    period credited by reconciliation (`reconcile.ts`, a `sub-period:` row) is
 *    never credited again by its late webhook: the webhook adopts that row. Only before any renewal has been
 *    credited, a success within a day of the activation and well before the
 *    known `nextBillAt` is the first charge echoed and is not credited twice.
 *  - UNSUBSCRIBED: Bonum's retries ran out and it ended the mandate
 *    (docs/providers/bonum-pitfalls.md #2). Cancelled; the customer can subscribe again.
 *  - PAYMENT: the hosted (All-in-one) invoice was paid, failed or expired.
 *  - TOKEN-PAYMENT: the result of a queued card purchase.
 *
 * Every payment goes through the ledger (UNIQUE provider + providerRef) in the
 * same batch as its state change and exactly one event, so a replay is a no-op.
 * Provider-side facts go to the activity timeline as short safe text; failures
 * carry Bonum's allowlisted codes (`failure.ts`), never its `message`. Throwing
 * makes the route answer 503, so Bonum retries.
 */
import { and, eq, inArray, like, ne, or } from 'drizzle-orm';
import { recordActivity, type ActivityInput } from '../../activity';
import { encrypt } from '../../crypto';
import { eventInserts } from '../../events/emit';
import { newId } from '../../ids';
import { isVerificationCharge, MoneyError, toMnt } from '../../money';
import {
	card as cardTable,
	cardSetup,
	charge as chargeTable,
	event,
	invoice as invoiceTable,
	ledger,
	plan as planTable,
	subscription as subTable,
	type CardSetup,
	type Plan,
	type Subscription
} from '../../schema';
import { failSetup, saveCard } from '../../services/cards';
import { failCharge, succeedCharge } from '../../services/charges';
import { nowOf, type ServiceContext } from '../../services/context';
import { endInvoice, settleInvoice } from '../../services/settle';
import { endMandate, subscriptionEventData } from '../../services/subscriptions';
import { withFailure } from './failure';
import { addInterval, billingPeriodKey, bonumTime } from './util';

export type WebhookResult = 'processed' | 'duplicate' | 'ignored';

/** Thrown when a webhook arrived before what it depends on; the route answers 503 and Bonum retries. */
export class WebhookRetryLater extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'WebhookRetryLater';
	}
}

/**
 * A renewal whose `completedAt` is more than this before `nextBillAt` cannot
 * be that renewal: it is the initial `payNow` charge echoed. Wide enough to
 * absorb a timezone slip, narrow enough for weekly plans.
 */
export const INITIAL_ECHO_MARGIN_MS = 12 * 60 * 60 * 1000;

/** The initial charge's echo arrives within this of the activation, never later. */
export const INITIAL_ECHO_WINDOW_MS = 24 * 60 * 60 * 1000;

type Body = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
/** Bonum ids are numbers in some messages and strings in others. */
const idOf = (v: unknown): string =>
	typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
const obj = (v: unknown): Body | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Body) : null);
const arr = (v: unknown): Body[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Body => x !== null) : []);
/** Only safe tokens reach the activity text. */
const safe = (v: string) => (/^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : '?');

async function note(ctx: ServiceContext, input: Omit<ActivityInput, 'source'>) {
	await recordActivity(ctx.db, { ...input, source: 'provider' }, nowOf(ctx));
}

/** An amount as integer MNT, or null (absent or malformed). 0.01 comes back as 0. */
function mnt(v: unknown): number | null {
	if (typeof v !== 'number' && typeof v !== 'string') return null;
	try {
		return toMnt(v);
	} catch (err) {
		if (err instanceof MoneyError) return null;
		throw err;
	}
}

async function planOf(ctx: ServiceContext, sub: Subscription): Promise<Plan> {
	const [row] = await ctx.db.select().from(planTable).where(eq(planTable.id, sub.planId)).limit(1);
	if (!row) throw new Error('subscription plan row missing');
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

/** The `card-token:` ledger row that credited the first charge at activation, if any. */
export async function activationLedgerRow(ctx: ServiceContext, sub: Subscription) {
	const [row] = await ctx.db
		.select({ createdAt: ledger.createdAt })
		.from(ledger)
		.where(and(eq(ledger.provider, 'bonum'), eq(ledger.providerRef, `card-token:${sub.tokenizeTransactionId}`)))
		.limit(1);
	return row;
}

/** Whether any renewal (a `sub-invoice:` or reconciled `sub-period:` ledger row) has been credited to this subscription. */
async function hasCreditedRenewal(ctx: ServiceContext, sub: Subscription): Promise<boolean> {
	const [row] = await ctx.db
		.select({ id: ledger.id })
		.from(ledger)
		.where(
			and(
				eq(ledger.provider, 'bonum'),
				eq(ledger.subjectId, sub.id),
				or(like(ledger.providerRef, 'sub-invoice:%'), like(ledger.providerRef, `${RECONCILED_REF_PREFIX}%`))
			)
		)
		.limit(1);
	return !!row;
}

/** The ledger row that already holds a renewal period for this subscription, if any. */
export async function periodHolder(ctx: ServiceContext, subjectId: string, periodKey: string) {
	const [row] = await ctx.db
		.select({ id: ledger.id, providerRef: ledger.providerRef })
		.from(ledger)
		.where(and(eq(ledger.subjectId, subjectId), eq(ledger.periodKey, periodKey)))
		.limit(1);
	return row;
}

/** Ledger refs of renewals credited by reconciliation (`reconcile.ts`), before any webhook confirmed them. */
export const RECONCILED_REF_PREFIX = 'sub-period:';

async function eventExists(ctx: ServiceContext, dedupeKey: string): Promise<boolean> {
	const [row] = await ctx.db.select({ id: event.id }).from(event).where(eq(event.dedupeKey, dedupeKey)).limit(1);
	return !!row;
}

async function subBy(ctx: ServiceContext, column: 'tokenize' | 'pending' | 'provider', value: string) {
	if (!value) return undefined;
	const col =
		column === 'tokenize'
			? subTable.tokenizeTransactionId
			: column === 'pending'
				? subTable.pendingTransactionId
				: subTable.providerSubscriptionId;
	const [row] = await ctx.db.select().from(subTable).where(eq(col, value)).limit(1);
	return row;
}

/** A mandate from a SUBSCRIPTION-PAYMENT / UNSUBSCRIBED body: Bonum's subscription id, else our tokenization id. */
async function mandateOf(ctx: ServiceContext, body: Body) {
	return (
		(await subBy(ctx, 'provider', idOf(body.subscriptionId))) ?? (await subBy(ctx, 'tokenize', str(body.transactionId)))
	);
}

/** The MNT amount in a CARD-TOKEN `amounts[]`, raw (so 0.01 can be told apart). */
function cardTokenAmount(body: Body): number | string | null {
	const entry = arr(body.amounts).find((a) => !a.currency || str(a.currency) === 'MNT');
	const v = entry?.amount;
	return typeof v === 'number' || typeof v === 'string' ? v : null;
}

/**
 * The shape of a CARD-TOKEN body, for the timeline: its field names and the
 * `amounts` entries. Only names, numbers and currency codes; never a value
 * of another field (the token is one of them).
 */
function reportedShape(body: Body): string {
	const name = (k: string) => (/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k) ? k : '?');
	const amounts = Array.isArray(body.amounts)
		? arr(body.amounts)
				.slice(0, 5)
				.map((a) =>
					Object.entries(a)
						.slice(0, 6)
						.map(([k, v]) => `${name(k)} ${typeof v === 'number' ? v : typeof v === 'string' ? safe(v) : typeof v}`)
						.join(', ')
				)
				.join('; ')
		: `not a list (${typeof body.amounts})`;
	return `Bonum reported amounts: ${amounts || 'none'}. Fields: ${Object.keys(body).slice(0, 30).map(name).join(', ')}`;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export async function handleBonumWebhook(ctx: ServiceContext, payload: unknown): Promise<WebhookResult> {
	const msg = obj(payload);
	const body = obj(msg?.body);
	const type = str(msg?.type).toUpperCase();
	const status = str(msg?.status).toUpperCase();
	if (!msg || !body) return 'ignored';
	const success = status === 'SUCCESS';

	switch (type) {
		case 'CARD-TOKEN':
			return cardToken(ctx, body, success);
		case 'SUBSCRIPTION-PAYMENT':
			return subscriptionPayment(ctx, body, success);
		case 'UNSUBSCRIBED':
			return unsubscribed(ctx, body);
		case 'PAYMENT':
			return invoicePayment(ctx, body, success);
		case 'TOKEN-PAYMENT':
			return tokenPayment(ctx, body, success);
		default:
			await note(ctx, {
				subjectType: 'provider',
				kind: 'bonum.webhook.unknown_type',
				summary: `Ignored a Bonum webhook of type ${safe(type)}`
			});
			return 'ignored';
	}
}

/* ------------------------------------------------------------------ *
 * CARD-TOKEN
 * ------------------------------------------------------------------ */

async function cardToken(ctx: ServiceContext, body: Body, success: boolean): Promise<WebhookResult> {
	const txn = str(body.transactionId);
	const initial = await subBy(ctx, 'tokenize', txn);
	if (initial) return success ? activate(ctx, initial, body) : checkoutFailed(ctx, initial, body, txn);

	let replacing = await subBy(ctx, 'pending', txn);
	if (!replacing && success) {
		// A replacement link superseded by a newer request still switches the card
		// at Bonum: match it by Bonum's subscription id if the message carries one.
		for (const s of arr(body.subscriptions)) {
			const candidate = await subBy(ctx, 'provider', idOf(s.subscriptionId));
			if (candidate?.pendingTransactionId) replacing = candidate;
		}
	}
	if (replacing) return success ? cardReplaced(ctx, replacing, body, txn) : replacementFailed(ctx, replacing, body, txn);

	const [setup] = txn ? await ctx.db.select().from(cardSetup).where(eq(cardSetup.id, txn)).limit(1) : [];
	if (setup) return success ? cardSaved(ctx, setup, body) : cardStepFailed(ctx, setup, body);

	await note(ctx, {
		subjectType: 'provider',
		kind: 'bonum.card_token.unknown',
		summary: `Ignored a card token for an unknown transaction ${safe(txn)}`
	});
	return 'ignored';
}

/** A plan-less card step succeeded: the card is saved, and a first payment in `amounts` is a charge. */
async function cardSaved(ctx: ServiceContext, setup: CardSetup, body: Body): Promise<WebhookResult> {
	const base = { projectId: setup.projectId, subjectType: 'card' as const, subjectId: setup.id };
	const token = str(body.token);
	if (!token) {
		await note(ctx, { ...base, kind: 'bonum.card_token.no_token', summary: 'Bonum reported a card without a token' });
		return 'ignored';
	}
	const raw = cardTokenAmount(body);
	const amount = raw === null || isVerificationCharge(raw) ? 0 : mnt(raw);
	if (amount === null) {
		await note(ctx, { ...base, kind: 'bonum.card_token.bad_amount', summary: 'The first payment had an unreadable amount' });
	}
	if (setup.paymentAmount !== null && amount !== setup.paymentAmount) {
		// What Bonum did report, so a first payment it describes differently can be read later.
		await note(ctx, { ...base, kind: 'bonum.card_token.reported', summary: reportedShape(body) });
	}
	const result = await saveCard(ctx, setup, {
		token,
		mask: str(body.mask).slice(0, 32) || '****',
		expiry: str(body.expiry).slice(0, 16) || null,
		bankName: str(obj(body.bank)?.name).slice(0, 100) || null,
		paidAmount: amount ?? 0
	});
	return result === 'saved' ? 'processed' : 'duplicate';
}

async function cardStepFailed(ctx: ServiceContext, setup: CardSetup, body: Body): Promise<WebhookResult> {
	const base = { projectId: setup.projectId, subjectType: 'card' as const, subjectId: setup.id };
	if (!(await failSetup(ctx, setup))) {
		if (setup.status === 'completed') {
			await note(ctx, { ...base, kind: 'bonum.card_token.failed_late', summary: withFailure('Ignored a failed tokenization for a card already saved', body) });
			return 'ignored';
		}
		return 'duplicate';
	}
	await note(ctx, { ...base, kind: 'bonum.card_token.failed', summary: withFailure('The customer did not complete the card step', body) });
	return 'processed';
}

async function newCardRow(ctx: ServiceContext, sub: Subscription, body: Body, token: string, now: number) {
	const id = newId();
	const bank = obj(body.bank);
	const statement = ctx.db.insert(cardTable).values({
		id,
		projectId: sub.projectId,
		customerRef: sub.customerRef,
		provider: 'bonum',
		tokenEnc: await encrypt(token, ctx.config.encryptionKey),
		mask: str(body.mask).slice(0, 32) || '****',
		expiry: str(body.expiry).slice(0, 16) || null,
		bankName: str(bank?.name).slice(0, 100) || null,
		status: 'active',
		createdAt: now,
		updatedAt: now
	});
	return { id, mask: str(body.mask).slice(0, 32) || '****', statement };
}

/** First CARD-TOKEN success: the mandate is live; with `payNow`, the first charge is in `amounts`. */
async function activate(ctx: ServiceContext, sub: Subscription, body: Body): Promise<WebhookResult> {
	const base = { projectId: sub.projectId, subjectType: 'subscription' as const, subjectId: sub.id };
	if (sub.status !== 'pending' && sub.status !== 'failed') return 'duplicate';
	const token = str(body.token);
	if (!token) {
		await note(ctx, { ...base, kind: 'bonum.card_token.no_token', summary: 'Bonum reported a card without a token' });
		return 'ignored';
	}
	const plan = await planOf(ctx, sub);
	const now = nowOf(ctx);
	const remotes = arr(body.subscriptions);
	const remote = remotes.find((s) => idOf(s.planId) === String(plan.providerPlanId)) ?? (remotes.length === 1 ? remotes[0] : undefined);
	const providerSubscriptionId = remote ? idOf(remote.subscriptionId) || null : null;
	if (!providerSubscriptionId) {
		await note(ctx, { ...base, kind: 'bonum.card_token.no_subscription', summary: 'The card token carried no Bonum subscription id' });
	}

	const raw = cardTokenAmount(body);
	const amount = raw === null || isVerificationCharge(raw) ? 0 : mnt(raw);
	if (amount === null) {
		await note(ctx, { ...base, kind: 'bonum.card_token.bad_amount', summary: 'The first charge had an unreadable amount' });
	} else if (amount > 0 && amount !== plan.amount) {
		await note(ctx, {
			...base,
			kind: 'bonum.card_token.amount_mismatch',
			summary: `The first charge was ${amount} MNT, not the plan's ${plan.amount} MNT`
		});
	}

	const completedAt = bonumTime(body.completedAt) ?? now;
	const remoteNextBillAt = bonumTime(remote?.nextBillingDate);
	const nextBillAt = remoteNextBillAt ?? addInterval(completedAt, plan.interval);
	// The first billing date fixes the day of month every later period keeps.
	const billingAnchor = remoteNextBillAt ?? completedAt;
	const card = await newCardRow(ctx, sub, body, token, now);
	const period = { start: completedAt, end: nextBillAt };
	const credited = amount !== null && amount > 0;
	const dedupeKey = `subscription.active:${sub.id}`;
	const { statements } = eventInserts(
		ctx.db,
		{
			projectId: sub.projectId,
			type: 'subscription.active',
			subjectId: sub.id,
			data: subscriptionEventData(sub, plan, {
				...(credited ? { amount } : {}),
				period,
				nextBillAt,
				cardMask: card.mask
			}),
			dedupeKey
		},
		now
	);
	try {
		await ctx.db.batch([
			card.statement,
			ctx.db
				.update(subTable)
				.set({
					status: 'active',
					providerSubscriptionId,
					cardId: card.id,
					currentPeriodStart: period.start,
					currentPeriodEnd: period.end,
					nextBillAt,
					billingAnchor,
					followUpLink: null,
					updatedAt: now
				})
				.where(and(eq(subTable.id, sub.id), inArray(subTable.status, ['pending', 'failed']))),
			...(credited
				? [
						ctx.db.insert(ledger).values({
							id: newId(),
							projectId: sub.projectId,
							provider: 'bonum',
							// The tokenization id is unique per checkout, so it keys the first charge.
							providerRef: `card-token:${sub.tokenizeTransactionId}`,
							kind: 'subscription',
							subjectId: sub.id,
							amount,
							createdAt: now
						})
					]
				: []),
			...statements
		]);
	} catch (err) {
		if (await eventExists(ctx, dedupeKey)) return 'duplicate';
		throw err;
	}
	await note(ctx, {
		...base,
		kind: 'bonum.card_token.succeeded',
		summary: credited ? `Card saved and first charge of ${amount} MNT taken` : 'Card saved; subscription active'
	});
	await flagDuplicateLive(ctx, sub);
	return 'processed';
}

/**
 * A late checkout (an abandoned, `failed` one whose CARD-TOKEN still arrived)
 * is activated anyway, since Bonum may have taken the money. If the customer
 * has since started another live subscription on the same plan, both are
 * flagged on the timeline so the dashboard can show the double mandate.
 */
async function flagDuplicateLive(ctx: ServiceContext, sub: Subscription) {
	const others = await ctx.db
		.select({ id: subTable.id })
		.from(subTable)
		.where(
			and(
				eq(subTable.projectId, sub.projectId),
				eq(subTable.customerRef, sub.customerRef),
				eq(subTable.planId, sub.planId),
				inArray(subTable.status, ['active', 'past_due']),
				ne(subTable.id, sub.id)
			)
		);
	for (const other of others) {
		for (const [subjectId, otherId] of [
			[sub.id, other.id],
			[other.id, sub.id]
		] as const) {
			await note(ctx, {
				projectId: sub.projectId,
				subjectType: 'subscription',
				subjectId,
				kind: 'bonum.duplicate_live_subscription',
				summary: `This customer has another live subscription on the same plan (${otherId}); cancel one of them`
			});
		}
	}
}

async function checkoutFailed(ctx: ServiceContext, sub: Subscription, body: Body, txn: string): Promise<WebhookResult> {
	const base = { projectId: sub.projectId, subjectType: 'subscription' as const, subjectId: sub.id };
	if (sub.status !== 'pending') {
		await note(ctx, { ...base, kind: 'bonum.card_token.failed_late', summary: withFailure('Ignored a failed tokenization for a subscription past checkout', body) });
		return 'ignored';
	}
	const plan = await planOf(ctx, sub);
	const now = nowOf(ctx);
	const dedupeKey = `subscription.checkout_failed:${sub.id}:${txn}`;
	const { statements } = eventInserts(
		ctx.db,
		{
			projectId: sub.projectId,
			type: 'subscription.payment_failed',
			subjectId: sub.id,
			data: subscriptionEventData(sub, plan, { reason: 'checkout_failed', nextBillAt: null }),
			dedupeKey
		},
		now
	);
	try {
		await ctx.db.batch([
			ctx.db
				.update(subTable)
				.set({ status: 'failed', followUpLink: null, updatedAt: now })
				.where(and(eq(subTable.id, sub.id), eq(subTable.status, 'pending'))),
			...statements
		]);
	} catch (err) {
		if (await eventExists(ctx, dedupeKey)) return 'duplicate';
		throw err;
	}
	await note(ctx, { ...base, kind: 'bonum.card_token.failed', summary: withFailure('The customer did not complete card checkout', body) });
	return 'processed';
}

/** A replacement CARD-TOKEN success: switch to the new card; 0.01 MNT is verification only. */
async function cardReplaced(ctx: ServiceContext, sub: Subscription, body: Body, txn: string): Promise<WebhookResult> {
	const base = { projectId: sub.projectId, subjectType: 'subscription' as const, subjectId: sub.id };
	if (sub.status !== 'active' && sub.status !== 'past_due') {
		await note(ctx, { ...base, kind: 'bonum.card_token.replaced_late', summary: `Ignored a new card for a ${sub.status} subscription` });
		return 'ignored';
	}
	const token = str(body.token);
	if (!token) {
		await note(ctx, { ...base, kind: 'bonum.card_token.no_token', summary: 'Bonum reported a card without a token' });
		return 'ignored';
	}
	const raw = cardTokenAmount(body);
	if (raw !== null && !isVerificationCharge(raw) && (mnt(raw) ?? 1) > 0) {
		// Not expected: a replacement is requested without a payment amount.
		await note(ctx, { ...base, kind: 'bonum.card_token.replacement_amount', summary: 'The card change carried a charge other than the 0.01 MNT check' });
	}
	const plan = await planOf(ctx, sub);
	const now = nowOf(ctx);
	const card = await newCardRow(ctx, sub, body, token, now);
	const dedupeKey = `subscription.card_changed:${txn}`;
	const { statements } = eventInserts(
		ctx.db,
		{
			projectId: sub.projectId,
			type: 'subscription.card_changed',
			subjectId: sub.id,
			data: subscriptionEventData(sub, plan, { cardMask: card.mask, nextBillAt: sub.nextBillAt }),
			dedupeKey
		},
		now
	);
	try {
		await ctx.db.batch([
			card.statement,
			...(sub.cardId
				? [
						ctx.db
							.update(cardTable)
							.set({ status: 'removed', tokenEnc: null, removedAt: now, updatedAt: now })
							.where(and(eq(cardTable.id, sub.cardId), eq(cardTable.status, 'active')))
					]
				: []),
			ctx.db
				.update(subTable)
				.set({ cardId: card.id, pendingTransactionId: null, followUpLink: null, updatedAt: now })
				.where(eq(subTable.id, sub.id)),
			...statements
		]);
	} catch (err) {
		if (await eventExists(ctx, dedupeKey)) return 'duplicate';
		throw err;
	}
	await note(ctx, { ...base, kind: 'bonum.card_token.replaced', summary: 'The subscription now uses a new card' });
	return 'processed';
}

async function replacementFailed(ctx: ServiceContext, sub: Subscription, body: Body, txn: string): Promise<WebhookResult> {
	await ctx.db
		.update(subTable)
		.set({ pendingTransactionId: null, followUpLink: null, updatedAt: nowOf(ctx) })
		.where(and(eq(subTable.id, sub.id), eq(subTable.pendingTransactionId, txn)));
	await note(ctx, {
		projectId: sub.projectId,
		subjectType: 'subscription',
		subjectId: sub.id,
		kind: 'bonum.card_token.replace_failed',
		summary: withFailure('The card change was not completed; the current card stays', body)
	});
	return 'processed';
}

/* ------------------------------------------------------------------ *
 * SUBSCRIPTION-PAYMENT
 * ------------------------------------------------------------------ */

async function subscriptionPayment(ctx: ServiceContext, body: Body, success: boolean): Promise<WebhookResult> {
	const sub = await mandateOf(ctx, body);
	if (!sub) {
		await note(ctx, { subjectType: 'provider', kind: 'bonum.subscription_payment.unknown', summary: 'Ignored a renewal for an unknown subscription' });
		return 'ignored';
	}
	const base = { projectId: sub.projectId, subjectType: 'subscription' as const, subjectId: sub.id };
	const plan = await planOf(ctx, sub);
	const planId = idOf(body.planId);
	if (planId && planId !== String(plan.providerPlanId)) {
		await note(ctx, { ...base, kind: 'bonum.subscription_payment.plan_mismatch', summary: `Ignored a renewal for Bonum plan ${safe(planId)}` });
		return 'ignored';
	}
	// The CARD-TOKEN that activates the mandate has not been applied yet: without
	// it, the initial-echo guard cannot tell a first charge from a renewal.
	if (sub.status === 'pending' || (sub.status === 'failed' && !sub.cardId)) {
		throw new WebhookRetryLater('subscription not active yet');
	}

	const invoiceId = idOf(body.invoiceId);
	if (!invoiceId) {
		// Never fall back to transactionId: it is the same on every renewal.
		await note(ctx, { ...base, kind: 'bonum.subscription_payment.no_invoice', summary: 'Ignored a renewal without an invoice id' });
		return 'ignored';
	}
	const ref = `sub-invoice:${invoiceId}`;
	const now = nowOf(ctx);
	const completedAt = bonumTime(body.completedAt) ?? now;

	if (!success) return renewalFailed(ctx, sub, plan, body, ref, invoiceId);

	if (await ledgerHas(ctx, ref)) return 'duplicate';
	const amount = mnt(body.amount);
	if (amount === null || amount === 0 || (body.currency !== undefined && str(body.currency) !== 'MNT')) {
		await note(ctx, { ...base, kind: 'bonum.subscription_payment.bad_amount', summary: 'Ignored a renewal with an unreadable amount' });
		return 'ignored';
	}
	if (amount !== plan.amount) {
		await note(ctx, {
			...base,
			kind: 'bonum.subscription_payment.amount_mismatch',
			summary: `A renewal of ${amount} MNT was taken, not the plan's ${plan.amount} MNT`
		});
	}

	// The billing period this charge pays for, from its own time (never from our
	// state), so it matches what reconciliation computed for the same charge.
	let periodKey = billingPeriodKey(completedAt, sub.billingAnchor, plan.interval);
	if (periodKey) {
		const holder = await periodHolder(ctx, sub.id, periodKey);
		if (holder?.providerRef.startsWith(RECONCILED_REF_PREFIX)) {
			// Reconciliation already credited this period from Bonum's lastBilledAt:
			// this is that charge's late webhook. Adopt the row (it now carries the
			// real invoice id, so a replay is a plain duplicate); credit nothing.
			const adopted = await ctx.db
				.update(ledger)
				.set({ providerRef: ref })
				.where(and(eq(ledger.id, holder.id), eq(ledger.providerRef, holder.providerRef)))
				.returning({ id: ledger.id });
			if (adopted.length === 1) {
				await note(ctx, {
					...base,
					kind: 'bonum.subscription_payment.reconciled_earlier',
					summary: `The renewal webhook (Bonum invoice ${safe(invoiceId)}) arrived for a period reconciliation had already credited; not credited twice`
				});
				return 'duplicate';
			}
		} else if (holder) {
			// A different Bonum invoice was already credited for the same scheduled
			// period: a second real charge (or Bonum's schedule differs from ours).
			// The money moved, so it is credited, outside the period guard.
			await note(ctx, {
				...base,
				kind: 'bonum.subscription_payment.same_period',
				summary: `A second renewal charge (Bonum invoice ${safe(invoiceId)}) for the period billed ${periodKey.slice(0, 10)}; credited, check the Bonum merchant portal`
			});
			periodKey = `${periodKey}:${invoiceId}`;
		}
	}

	let period: { start: number; end: number };
	const dueAt = sub.nextBillAt ?? sub.currentPeriodEnd;
	// The initial payNow charge echoed as a renewal: only before any renewal was
	// credited, within a day of the activation, and well before the next bill.
	// Once renewals flow, an early one (our nextBillAt ahead of Bonum's) is
	// always credited (docs/providers/bonum-pitfalls.md #1).
	const activation = await activationLedgerRow(ctx, sub);
	// Without a credited first charge, the period start is CARD-TOKEN's completedAt.
	const activatedAt = activation?.createdAt ?? sub.currentPeriodStart;
	const maybeInitial =
		dueAt !== null &&
		completedAt < dueAt - INITIAL_ECHO_MARGIN_MS &&
		activatedAt !== null &&
		Math.abs(completedAt - activatedAt) <= INITIAL_ECHO_WINDOW_MS &&
		!(await hasCreditedRenewal(ctx, sub));
	if (maybeInitial) {
		if (activation) {
			// The initial payNow charge, already credited from CARD-TOKEN.
			await note(ctx, { ...base, kind: 'bonum.subscription_payment.initial_echo', summary: 'Ignored the first charge reported again as a renewal' });
			return 'duplicate';
		}
		// CARD-TOKEN carried no amount: this is the first charge. Credit it
		// without moving the period on.
		period = { start: sub.currentPeriodStart ?? completedAt, end: dueAt! };
	} else {
		let start = dueAt ?? completedAt;
		let end = addInterval(start, plan.interval, sub.billingAnchor);
		if (end <= completedAt) {
			start = completedAt;
			end = addInterval(start, plan.interval);
		}
		// Bonum's own next billing date wins when the message carries one.
		const remoteNext = bonumTime(body.nextBillingDate);
		if (remoteNext !== null && remoteNext > completedAt) end = remoteNext;
		period = { start, end };
	}

	const cancelled = sub.status === 'cancelled';
	const nextBillAt = cancelled ? null : period.end;
	const { statements } = eventInserts(
		ctx.db,
		{
			projectId: sub.projectId,
			type: 'subscription.renewed',
			subjectId: sub.id,
			data: subscriptionEventData(sub, plan, { amount, period, nextBillAt })
		},
		now
	);
	try {
		await ctx.db.batch([
			ctx.db.insert(ledger).values({
				id: newId(),
				projectId: sub.projectId,
				provider: 'bonum',
				providerRef: ref,
				kind: 'subscription',
				subjectId: sub.id,
				amount,
				periodKey,
				createdAt: now
			}),
			ctx.db
				.update(subTable)
				.set({
					...(cancelled ? {} : { status: 'active' as const, nextBillAt }),
					currentPeriodStart: period.start,
					currentPeriodEnd: period.end,
					updatedAt: now
				})
				.where(eq(subTable.id, sub.id)),
			...statements
		]);
	} catch (err) {
		if (await ledgerHas(ctx, ref)) return 'duplicate';
		// Reconciliation credited the period in between: Bonum retries (503) and
		// the next attempt adopts that row.
		throw err;
	}
	await note(ctx, { ...base, kind: 'bonum.subscription_payment.succeeded', summary: `Renewal of ${amount} MNT taken` });
	return 'processed';
}

async function renewalFailed(
	ctx: ServiceContext,
	sub: Subscription,
	plan: Plan,
	body: Body,
	ref: string,
	invoiceId: string
): Promise<WebhookResult> {
	const base = { projectId: sub.projectId, subjectType: 'subscription' as const, subjectId: sub.id };
	if (sub.status === 'cancelled' || sub.status === 'failed') return 'ignored';
	// A failure for an invoice that was paid after all (retries, out of order) changes nothing.
	if (await ledgerHas(ctx, ref)) return 'duplicate';
	// Nor does a late failure for a period already credited (a retry succeeded,
	// or reconciliation found it billed).
	const failedAt = bonumTime(body.completedAt) ?? bonumTime(body.updatedAt);
	const failedKey = failedAt === null ? null : billingPeriodKey(failedAt, sub.billingAnchor, plan.interval);
	if (failedKey && (await periodHolder(ctx, sub.id, failedKey))) {
		await note(ctx, { ...base, kind: 'bonum.subscription_payment.failed_late', summary: withFailure('Ignored a failed renewal attempt for a period already paid', body) });
		return 'duplicate';
	}
	const now = nowOf(ctx);
	const attempt = str(body.completedAt) || str(body.updatedAt) || idOf(body.updatedAt) || 'first';
	const dedupeKey = `subscription.payment_failed:${sub.id}:${invoiceId}:${attempt}`;
	const amount = mnt(body.amount);
	const { statements } = eventInserts(
		ctx.db,
		{
			projectId: sub.projectId,
			type: 'subscription.payment_failed',
			subjectId: sub.id,
			data: subscriptionEventData(sub, plan, {
				...(amount ? { amount } : {}),
				reason: 'payment_failed',
				nextBillAt: sub.nextBillAt
			}),
			dedupeKey
		},
		now
	);
	try {
		await ctx.db.batch([
			ctx.db
				.update(subTable)
				.set({ status: 'past_due', updatedAt: now })
				.where(and(eq(subTable.id, sub.id), inArray(subTable.status, ['active', 'past_due']))),
			...statements
		]);
	} catch (err) {
		if (await eventExists(ctx, dedupeKey)) return 'duplicate';
		throw err;
	}
	await note(ctx, { ...base, kind: 'bonum.subscription_payment.failed', summary: withFailure('A renewal charge failed; Bonum will retry', body) });
	return 'processed';
}

/* ------------------------------------------------------------------ *
 * UNSUBSCRIBED
 * ------------------------------------------------------------------ */

async function unsubscribed(ctx: ServiceContext, body: Body): Promise<WebhookResult> {
	const sub = await mandateOf(ctx, body);
	if (!sub) {
		await note(ctx, { subjectType: 'provider', kind: 'bonum.unsubscribed.unknown', summary: 'Ignored UNSUBSCRIBED for an unknown subscription' });
		return 'ignored';
	}
	if (sub.status === 'cancelled') return 'duplicate';
	if (sub.status === 'pending') throw new WebhookRetryLater('subscription not active yet');
	const plan = await planOf(ctx, sub);
	const now = nowOf(ctx);
	const ended = await endMandate(ctx, sub, plan, 'retries_exhausted', now);
	if (!ended) return 'duplicate';
	await note(ctx, {
		projectId: sub.projectId,
		subjectType: 'subscription',
		subjectId: sub.id,
		kind: 'bonum.unsubscribed',
		summary: 'Bonum ended the subscription after its retries ran out'
	});
	return 'processed';
}

/* ------------------------------------------------------------------ *
 * PAYMENT (hosted invoice)
 * ------------------------------------------------------------------ */

async function invoicePayment(ctx: ServiceContext, body: Body, success: boolean): Promise<WebhookResult> {
	const txn = str(body.transactionId);
	const bonumInvoiceId = idOf(body.invoiceId);
	let [inv] = txn
		? await ctx.db
				.select()
				.from(invoiceTable)
				.where(and(eq(invoiceTable.id, txn), eq(invoiceTable.provider, 'bonum')))
				.limit(1)
		: [];
	if (!inv && bonumInvoiceId) {
		[inv] = await ctx.db
			.select()
			.from(invoiceTable)
			.where(and(eq(invoiceTable.providerInvoiceId, bonumInvoiceId), eq(invoiceTable.provider, 'bonum')))
			.limit(1);
	}
	if (!inv) {
		await note(ctx, { subjectType: 'provider', kind: 'bonum.payment.unknown', summary: `Ignored a payment for an unknown invoice ${safe(txn)}` });
		return 'ignored';
	}
	const base = { projectId: inv.projectId, subjectType: 'invoice' as const, subjectId: inv.id };

	if (!success) {
		const expired = str(body.invoiceStatus).toUpperCase() === 'EXPIRED';
		const ended = await endInvoice(ctx, inv, expired ? 'expired' : 'failed');
		await note(ctx, {
			...base,
			kind: expired ? 'bonum.payment.expired' : 'bonum.payment.failed',
			summary: withFailure(expired ? 'Bonum reported the invoice expired' : 'Bonum reported the payment failed', body)
		});
		return ended ? 'processed' : 'duplicate';
	}

	const providerRef = bonumInvoiceId || inv.providerInvoiceId || '';
	const amount = mnt(body.amount);
	if (!providerRef || amount === null) {
		await note(ctx, { ...base, kind: 'bonum.payment.unreadable', summary: 'Ignored a payment without an invoice id or amount' });
		return 'ignored';
	}
	const paidAt = bonumTime(body.completedAt) ?? nowOf(ctx);
	const result = await settleInvoice(ctx, inv, { providerRef, amount, paidAt });
	if (result === 'amount_mismatch') {
		await note(ctx, {
			...base,
			kind: 'bonum.payment.amount_mismatch',
			summary: `Bonum reported ${amount} MNT paid for a ${inv.amount} MNT invoice; not marked paid`
		});
		return 'ignored';
	}
	if (result === 'settled') {
		const vendor = safe(str(body.paymentVendor) || 'unknown');
		await note(ctx, { ...base, kind: 'bonum.payment.paid', summary: `Paid through Bonum (${vendor})` });
		return 'processed';
	}
	return 'duplicate';
}

/* ------------------------------------------------------------------ *
 * TOKEN-PAYMENT (queued purchase result)
 * ------------------------------------------------------------------ */

async function tokenPayment(ctx: ServiceContext, body: Body, success: boolean): Promise<WebhookResult> {
	const txn = str(body.transactionId);
	const [c] = txn
		? await ctx.db.select().from(chargeTable).where(eq(chargeTable.providerTransactionId, txn)).limit(1)
		: [];
	if (!c) {
		await note(ctx, { subjectType: 'provider', kind: 'bonum.token_payment.unknown', summary: `Ignored a card payment result for an unknown transaction ${safe(txn)}` });
		return 'ignored';
	}
	const base = { projectId: c.projectId, subjectType: 'charge' as const, subjectId: c.id };
	if (success) {
		const r = await succeedCharge(ctx, c);
		if (r === 'settled') await note(ctx, { ...base, kind: 'bonum.token_payment.succeeded', summary: 'The queued card payment went through' });
		return r === 'settled' ? 'processed' : 'duplicate';
	}
	const r = await failCharge(ctx, c, 'card_declined');
	if (r === 'failed') await note(ctx, { ...base, kind: 'bonum.token_payment.failed', summary: withFailure('The queued card payment was declined', body) });
	return r === 'failed' ? 'processed' : 'duplicate';
}
