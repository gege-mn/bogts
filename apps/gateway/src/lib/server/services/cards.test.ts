import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { decrypt } from '../crypto';
import { newId } from '../ids';
import { resetBonumTokenCache } from '../providers/bonum/client';
import { fakeBonum, jsonResponse } from '../providers/bonum/testing';
import { handleBonumWebhook } from '../providers/bonum/webhook';
import { activity, card as cardTable, cardSetup, charge as chargeTable, event, ledger, subscription as subTable, type Project } from '../schema';
import { createTestDb, seedPlan, seedProject, TEST_ENCRYPTION_KEY, testConfig, type TestDb } from '../testdb';
import { createCard, getCard, listCards, removeCard, replaceSavedCard } from './cards';
import { createCharge, reverseCharge } from './charges';
import type { ServiceContext } from './context';
import { openInvoice } from './invoices';

const TOKENIZE = 'POST /mpay-service/merchant/cards/tokenize/request';
const PURCHASE = 'POST /mpay-service/merchant/transaction/purchase';
const tokenizeOk = () => jsonResponse({ followUpLink: 'https://ecommerce.bonum.mn/tokenize?id=73c6', id: '73c6' });
const purchaseOk = () => jsonResponse({ data: { id: 1, completedAt: '2026-01-13 11:55:44', status: 'SUCCESS' }, status: 200 });

let db: TestDb;
let ctx: ServiceContext;
let project: Project;

beforeEach(async () => {
	db = createTestDb();
	ctx = { db, config: testConfig(), now: Date.UTC(2026, 8, 25, 4) };
	project = (await seedProject(db)).project;
	resetBonumTokenCache();
});
afterEach(() => vi.unstubAllGlobals());

const returnUrl = 'https://project.test/billing';
const types = async () => (await db.select().from(event)).map((e) => e.type).sort();

/** Bonum's CARD-TOKEN for a plan-less tokenization: no `subscriptions`. */
const cardTokenMessage = (transactionId: string, amount: number, status = 'SUCCESS', token = `token-${transactionId}`) => ({
	type: 'CARD-TOKEN',
	status,
	message: '',
	body: {
		token,
		mask: '5150 23** **** 4778',
		expiry: '2026/11',
		bank: { id: 19, name: 'Голомт банк' },
		transactionId,
		completedAt: '2026-09-25 12:58:03',
		amounts: [{ amount, currency: 'MNT' }]
	}
});

/** A saved card: the card step, then Bonum's webhook. */
async function savedCard(customerRef = 'user-1') {
	fakeBonum({ [TOKENIZE]: tokenizeOk });
	const pending = await createCard(ctx, project, { customerRef, returnUrl });
	await handleBonumWebhook(ctx, cardTokenMessage(pending.id, 0.01));
	return pending.id;
}

describe('createCard', () => {
	it('asks Bonum for a plain card token (no subscription, no payment) and returns the pending card', async () => {
		const bonum = fakeBonum({ [TOKENIZE]: tokenizeOk });
		const c = await createCard(ctx, project, { customerRef: 'user-1', returnUrl });
		expect(c).toMatchObject({ object: 'card', status: 'pending', customerRef: 'user-1', mask: null });
		expect(c.redirectUrl).toBe('https://ecommerce.bonum.mn/tokenize?id=73c6');
		const [call] = bonum.to(TOKENIZE);
		expect(call!.body).toEqual({ callback: `${ctx.config.publicOrigin}/return/c/${c.id}`, transactionId: c.id });
		expect(await getCard(ctx, project.id, c.id)).toEqual(c);
		expect(await db.select().from(cardTable)).toHaveLength(0);
	});

	it('sends a first payment as payment.amount: the total of the items, discount included', async () => {
		const bonum = fakeBonum({ [TOKENIZE]: tokenizeOk });
		await createCard(ctx, project, {
			customerRef: 'user-1',
			returnUrl,
			payment: {
				reference: 'order-1',
				items: [
					{ label: 'Pro, first month', amount: 49_900, quantity: 1 },
					{ label: 'Launch discount', amount: -10_000, quantity: 1 }
				]
			}
		});
		const body = bonum.to(TOKENIZE)[0]!.body as { payment: unknown; items: { amount: number; title: string }[] };
		expect(body.payment).toEqual({ amount: 39_900 });
		expect(body.items).toEqual([{ image: '', title: 'Pro, first month', remark: '', amount: 39_900, count: 1 }]);
	});

	it('refuses a payment whose discounts take the total to zero', async () => {
		fakeBonum({ [TOKENIZE]: tokenizeOk });
		const run = createCard(ctx, project, {
			customerRef: 'user-1',
			returnUrl,
			payment: { reference: 'order-1', items: [{ label: 'Pro', amount: 100, quantity: 1 }, { label: 'Free', amount: -100, quantity: 1 }] }
		});
		await expect(run).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
		expect(await db.select().from(cardSetup)).toHaveLength(0);
	});

	it('when Bonum refuses, the step is failed and card.failed is emitted once', async () => {
		fakeBonum({ [TOKENIZE]: () => jsonResponse({ status: 500 }, 500) });
		await expect(createCard(ctx, project, { customerRef: 'user-1', returnUrl })).rejects.toBeInstanceOf(ApiError);
		const [setup] = await db.select().from(cardSetup);
		expect(setup!.status).toBe('failed');
		expect(await types()).toEqual(['card.failed']);
	});
});

describe('CARD-TOKEN for a card step', () => {
	it('saves the card under the step id; the 0.01 MNT check is not a charge', async () => {
		const id = await savedCard();
		const [card] = await db.select().from(cardTable);
		expect(card).toMatchObject({ id, status: 'active', customerRef: 'user-1', mask: '5150 23** **** 4778', bankName: 'Голомт банк' });
		expect(await decrypt(card!.tokenEnc!, TEST_ENCRYPTION_KEY)).toBe(`token-${id}`);
		expect(await db.select().from(chargeTable)).toHaveLength(0);
		expect(await db.select().from(ledger)).toHaveLength(0);
		expect(await types()).toEqual(['card.saved']);
		const json = await getCard(ctx, project.id, id);
		expect(json).toMatchObject({ status: 'active', redirectUrl: null, bank: 'Голомт банк' });
		expect(JSON.stringify(json)).not.toContain('token-');
	});

	it('a replay saves nothing twice', async () => {
		const id = await savedCard();
		expect(await handleBonumWebhook(ctx, cardTokenMessage(id, 0.01))).toBe('duplicate');
		expect(await db.select().from(cardTable)).toHaveLength(1);
		expect(await types()).toEqual(['card.saved']);
	});

	it('a first payment becomes a succeeded charge with its items, one ledger row and charge.succeeded', async () => {
		fakeBonum({ [TOKENIZE]: tokenizeOk });
		const items = [
			{ label: 'Pro', amount: 49_900, quantity: 1 },
			{ label: 'Discount', amount: -9_900, quantity: 1 }
		];
		const pending = await createCard(ctx, project, { customerRef: 'user-1', returnUrl, payment: { reference: 'order-1', items } });
		expect(await handleBonumWebhook(ctx, cardTokenMessage(pending.id, 40_000))).toBe('processed');
		const [charge] = await db.select().from(chargeTable);
		expect(charge).toMatchObject({ cardId: pending.id, status: 'succeeded', amount: 40_000, reference: 'order-1', items, providerTransactionId: pending.id });
		const rows = await db.select().from(ledger);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: 'charge', subjectId: charge!.id, amount: 40_000 });
		expect(await types()).toEqual(['card.saved', 'charge.succeeded']);
		const saved = (await db.select().from(event)).find((e) => e.type === 'card.saved')!;
		expect(saved.data).toMatchObject({ cardId: pending.id, chargeId: charge!.id, customerRef: 'user-1' });
		// The replay credits nothing more.
		await handleBonumWebhook(ctx, cardTokenMessage(pending.id, 40_000));
		expect(await db.select().from(ledger)).toHaveLength(1);
	});

	it('a failed step ends failed with card.failed; a later success still saves the card', async () => {
		fakeBonum({ [TOKENIZE]: tokenizeOk });
		const pending = await createCard(ctx, project, { customerRef: 'user-1', returnUrl });
		expect(await handleBonumWebhook(ctx, cardTokenMessage(pending.id, 0.01, 'FAILED'))).toBe('processed');
		expect(await getCard(ctx, project.id, pending.id)).toMatchObject({ status: 'failed', redirectUrl: null });
		expect(await handleBonumWebhook(ctx, cardTokenMessage(pending.id, 0.01, 'FAILED'))).toBe('duplicate');
		expect(await handleBonumWebhook(ctx, cardTokenMessage(pending.id, 0.01))).toBe('processed');
		expect(await getCard(ctx, project.id, pending.id)).toMatchObject({ status: 'active' });
		expect(await types()).toEqual(['card.failed', 'card.saved']);
	});
});

describe('several cards and projects', () => {
	it('a customer can have several cards; another project with the same customerRef sees none of them', async () => {
		const a = await savedCard('user-1');
		const b = await savedCard('user-1');
		const other = (await seedProject(db)).project;
		const page = await listCards(ctx, project.id, { limit: 20, customerRef: 'user-1' });
		expect(page.data.map((c) => c.id).sort()).toEqual([a, b].sort());
		expect((await listCards(ctx, other.id, { limit: 20, customerRef: 'user-1' })).data).toEqual([]);
		await expect(getCard(ctx, other.id, a)).rejects.toMatchObject({ status: 404 });
		fakeBonum({ [PURCHASE]: purchaseOk });
		await expect(createCharge(ctx, other, { cardId: a, amount: 1_000, reference: 'x' })).rejects.toMatchObject({ status: 404 });
	});
});

describe('charging a saved card', () => {
	it('charges by cardId, with no subscription, and reverses with the card token', async () => {
		const cardId = await savedCard();
		const bonum = fakeBonum({ [PURCHASE]: purchaseOk });
		const items = [
			{ label: 'Top-up', amount: 5_000, quantity: 2 },
			{ label: '20% off', amount: -2_000, quantity: 1 }
		];
		const c = await createCharge(ctx, project, { cardId, items, reference: 'topup-7' });
		expect(c).toMatchObject({ status: 'succeeded', amount: 8_000, cardId, subscriptionId: null, items });
		const [call] = bonum.to(PURCHASE);
		expect(call!.body).toEqual({ amount: 8_000, currency: 'MNT', transactionId: c.id });
		expect(call!.headers.get('x-card-token')).toBe(`token-${cardId}`);
		const succeeded = (await db.select().from(event)).find((e) => e.type === 'charge.succeeded')!;
		expect(succeeded.data).toMatchObject({ chargeId: c.id, cardId, customerRef: 'user-1', amount: 8_000, items });

		const reverse = fakeBonum({ [`DELETE /mpay-service/merchant/transaction/reverse/${c.id}`]: () => jsonResponse({}) });
		expect(await reverseCharge(ctx, project.id, c.id)).toMatchObject({ status: 'reversed' });
		expect(reverse.calls.at(-1)!.headers.get('x-card-token')).toBe(`token-${cardId}`);
	});

	it('needs exactly one of cardId and subscriptionId, and one of amount and items', async () => {
		const cardId = await savedCard();
		fakeBonum({ [PURCHASE]: purchaseOk });
		await expect(createCharge(ctx, project, { amount: 1_000, reference: 'x' })).rejects.toMatchObject({ status: 400 });
		await expect(createCharge(ctx, project, { cardId, subscriptionId: 'y', amount: 1_000, reference: 'x' })).rejects.toMatchObject({ status: 400 });
		await expect(createCharge(ctx, project, { cardId, reference: 'x' })).rejects.toMatchObject({ status: 400 });
		await expect(
			createCharge(ctx, project, { cardId, amount: 1_000, items: [{ label: 'a', amount: 1_000, quantity: 1 }], reference: 'x' })
		).rejects.toMatchObject({ status: 400 });
		expect(await db.select().from(chargeTable)).toHaveLength(0);
	});
});

describe('replace and remove', () => {
	it('replacing keeps the old card until the new one is saved, then removes it', async () => {
		const oldId = await savedCard();
		fakeBonum({ [TOKENIZE]: tokenizeOk });
		const pending = await replaceSavedCard(ctx, project.id, oldId, { returnUrl });
		expect(pending).toMatchObject({ status: 'pending', customerRef: 'user-1' });
		expect(pending.id).not.toBe(oldId);
		expect(await getCard(ctx, project.id, oldId)).toMatchObject({ status: 'active' });

		await handleBonumWebhook(ctx, cardTokenMessage(pending.id, 0.01));
		expect(await getCard(ctx, project.id, pending.id)).toMatchObject({ status: 'active' });
		const [old] = await db.select().from(cardTable).where(eq(cardTable.id, oldId));
		expect(old).toMatchObject({ status: 'removed', tokenEnc: null });
		const replaced = (await db.select().from(event)).find((e) => e.type === 'card.replaced')!;
		expect(replaced.data).toMatchObject({ cardId: pending.id, replacesCardId: oldId });
	});

	it('a replacement the customer gives up on leaves the old card in place', async () => {
		const oldId = await savedCard();
		fakeBonum({ [TOKENIZE]: tokenizeOk });
		const pending = await replaceSavedCard(ctx, project.id, oldId, { returnUrl });
		await handleBonumWebhook(ctx, cardTokenMessage(pending.id, 0.01, 'FAILED'));
		expect(await getCard(ctx, project.id, oldId)).toMatchObject({ status: 'active' });
	});

	it('removing drops the token, emits card.removed once, and the card can no longer be charged', async () => {
		const cardId = await savedCard();
		expect(await removeCard(ctx, project.id, cardId)).toMatchObject({ status: 'removed' });
		expect(await removeCard(ctx, project.id, cardId)).toMatchObject({ status: 'removed' });
		const [row] = await db.select().from(cardTable);
		expect(row!.tokenEnc).toBeNull();
		expect((await types()).filter((t) => t === 'card.removed')).toHaveLength(1);
		const bonum = fakeBonum({ [PURCHASE]: purchaseOk });
		await expect(createCharge(ctx, project, { cardId, amount: 1_000, reference: 'x' })).rejects.toMatchObject({ status: 409 });
		expect(bonum.to(PURCHASE)).toHaveLength(0);
	});

	it('a card billed by a live Bonum-plan subscription can be neither removed nor replaced here', async () => {
		const cardId = await savedCard();
		const plan = await seedPlan(db, project.id);
		const subId = newId();
		await db.insert(subTable).values({
			id: subId,
			projectId: project.id,
			planId: plan.id,
			customerRef: 'user-1',
			status: 'active',
			providerSubscriptionId: '41',
			tokenizeTransactionId: subId,
			cardId,
			createdAt: ctx.now!,
			updatedAt: ctx.now!
		});
		await expect(removeCard(ctx, project.id, cardId)).rejects.toMatchObject({ status: 409 });
		await expect(replaceSavedCard(ctx, project.id, cardId, { returnUrl })).rejects.toMatchObject({ status: 409 });
		expect(await getCard(ctx, project.id, cardId)).toMatchObject({ status: 'active' });
	});
});

describe('invoice items', () => {
	it('an invoice takes items in place of amount, and a different discount is a different purchase', async () => {
		fakeBonum({
			'POST /bonum-gateway/ecommerce/invoices': (_c, n) =>
				jsonResponse({ invoiceId: `inv-${n}`, followUpLink: `https://ecommerce.bonum.mn/pay?id=${n}` })
		});
		const base = { provider: 'bonum' as const, reference: 'order-9', description: 'Order 9' };
		const items = [
			{ label: 'Book', amount: 30_000, quantity: 2 },
			{ label: 'Coupon', amount: -5_000 }
		];
		const first = await openInvoice(ctx, project, { ...base, items });
		expect(first.invoice).toMatchObject({ amount: 55_000, items: [items[0], { ...items[1], quantity: 1 }] });
		expect((await openInvoice(ctx, project, { ...base, items })).reused).toBe(true);
		const other = await openInvoice(ctx, project, { ...base, items: [{ label: 'Book', amount: 55_000 }] });
		expect(other.reused).toBe(false);
		await expect(openInvoice(ctx, project, { ...base, amount: 1, items })).rejects.toMatchObject({ status: 400 });
		await expect(openInvoice(ctx, project, base)).rejects.toMatchObject({ status: 400 });
	});
});

describe('what Bonum said, on the timeline', () => {
	const summaries = async (kind: string) => (await db.select().from(activity).where(eq(activity.kind, kind))).map((a) => a.summary);

	it('a declined charge keeps the HTTP status, card status and bank code', async () => {
		const cardId = await savedCard();
		fakeBonum({
			[PURCHASE]: () =>
				jsonResponse(
					{
						errorCode: '${invalid.bonum.response.56}',
						message: 'Картаар төлбөр хийх боломжгүй (56)',
						data: { id: 171044, status: 'FAILED', cardStatus: 'INACTIVE' },
						status: 400
					},
					400
				)
		});
		const c = await createCharge(ctx, project, { cardId, amount: 500, reference: 'r-1' });
		expect(c).toMatchObject({ status: 'failed', failureCode: 'card_declined' });
		expect(await summaries('bonum.purchase.declined')).toEqual(['The card was declined (HTTP 400. Bonum: FAILED, INACTIVE, bank code 56)']);
	});

	it('a first payment Bonum reports differently records the shape of its message, never the token', async () => {
		fakeBonum({ [TOKENIZE]: tokenizeOk });
		const pending = await createCard(ctx, project, { customerRef: 'user-1', returnUrl, payment: { amount: 100, reference: 'order-1' } });
		await handleBonumWebhook(ctx, cardTokenMessage(pending.id, 0.01));
		const [text] = await summaries('bonum.card_token.reported');
		expect(text).toBe(
			'Bonum reported amounts: amount 0.01, currency MNT. Fields: token, mask, expiry, bank, transactionId, completedAt, amounts'
		);
		expect(text).not.toContain(`token-${pending.id}`);
	});
});
