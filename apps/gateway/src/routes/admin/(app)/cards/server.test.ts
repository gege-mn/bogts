import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBonumTokenCache } from '$lib/server/providers/bonum/client';
import { fakeBonum, jsonResponse } from '$lib/server/providers/bonum/testing';
import { handleBonumWebhook } from '$lib/server/providers/bonum/webhook';
import { auditLog, card, cardSetup, charge, type Project } from '$lib/server/schema';
import { createTestDb, seedProject, testConfig, type TestDb } from '$lib/server/testdb';
import { load as listLoad } from './+page.server';
import { actions as cardActions, load as cardLoad } from './[id]/+page.server';
import { actions as newActions } from './new/+page.server';

const TOKENIZE = 'POST /mpay-service/merchant/cards/tokenize/request';
const PURCHASE = 'POST /mpay-service/merchant/transaction/purchase';
const LINK = 'https://ecommerce.bonum.mn/tokenize?id=73c6';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const call = (fn: unknown, e: unknown) => (fn as (e: unknown) => Promise<Any>)(e);

let db: TestDb;
let project: Project;

function event(path: string, form?: Record<string, string>, params: Record<string, string> = {}) {
	const url = new URL(`https://payments.test${path}`);
	const locals = { db, config: testConfig(), admin: { method: 'password' }, env: {}, waitUntil: () => {} };
	const body = new FormData();
	for (const [k, v] of Object.entries(form ?? {})) body.set(k, v);
	return { locals, url, params, request: new Request(url, { method: 'POST', body }), parent: async () => ({}) };
}

/** Starts a card step from the dashboard and returns its id. */
async function start(form: Record<string, string> = {}) {
	fakeBonum({ [TOKENIZE]: () => jsonResponse({ followUpLink: LINK, id: '73c6' }) });
	expect(await call(newActions.default, event('/admin/cards/new', { projectId: project.id, customerRef: 'user-1', ...form }))).toEqual({
		redirectUrl: LINK
	});
	const [setup] = await db.select().from(cardSetup);
	return setup!;
}

const cardToken = (transactionId: string, amount: number) => ({
	type: 'CARD-TOKEN',
	status: 'SUCCESS',
	message: '',
	body: {
		token: `token-${transactionId}`,
		mask: '5150 23** **** 4778',
		expiry: '2026/11',
		bank: { id: 19, name: 'Голомт банк' },
		transactionId,
		completedAt: '2026-09-25 12:58:03',
		amounts: [{ amount, currency: 'MNT' }]
	}
});

beforeEach(async () => {
	db = createTestDb();
	project = (await seedProject(db, { name: 'Nomad Coffee' })).project;
	resetBonumTokenCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('/admin/cards', () => {
	it('starts a card step that returns to the dashboard, and refuses bad input', async () => {
		const setup = await start();
		expect(setup).toMatchObject({ projectId: project.id, customerRef: 'user-1', status: 'pending', paymentAmount: null });
		expect(setup.returnUrl).toBe(`${testConfig().publicOrigin}/admin/cards`);
		expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual(['card.create']);
		// Bonum sends the browser back with `?card=<id>`.
		await expect(call(listLoad, event(`/admin/cards?card=${setup.id}`))).rejects.toMatchObject({ status: 303, location: `/admin/cards/${setup.id}` });

		const bad = await call(newActions.default, event('/admin/cards/new', { projectId: project.id, customerRef: 'user-2', amount: '12.5' }));
		expect(bad).toMatchObject({ status: 400, data: { action: 'create', customerRef: 'user-2', amount: '12.5' } });
		expect(await db.select().from(cardSetup)).toHaveLength(1);
	});

	for (const strict of [true, false]) {
		it(`lists and shows a card through its states (${strict ? 'strict columns' : 'exactly like D1'})`, async () => {
			const setup = await start({ amount: '1500', reference: 'order-1' });
			db.$d1.strictColumns = strict;

			const pending = await call(listLoad, event('/admin/cards?status=pending'));
			expect(pending.page.rows).toMatchObject([{ id: setup.id, projectName: 'Nomad Coffee', customerRef: 'user-1', status: 'pending', mask: null }]);
			expect(pending.counts).toEqual({ all: 0, pending: 1 });
			const waiting = await call(cardLoad, event(`/admin/cards/${setup.id}`, undefined, { id: setup.id }));
			expect(waiting.card).toMatchObject({ status: 'pending', cardPageUrl: LINK, firstPayment: { amount: 1500, reference: 'order-1' } });

			db.$d1.strictColumns = false;
			await handleBonumWebhook({ db, config: testConfig() }, cardToken(setup.id, 1500));
			db.$d1.strictColumns = strict;

			const saved = await call(listLoad, event('/admin/cards'));
			expect(saved.page.rows).toMatchObject([{ id: setup.id, projectName: 'Nomad Coffee', status: 'active', mask: '5150 23** **** 4778', bankName: 'Голомт банк' }]);
			expect(saved.counts).toEqual({ all: 1, active: 1 });
			const d = await call(cardLoad, event(`/admin/cards/${setup.id}`, undefined, { id: setup.id }));
			expect(d.project).toEqual({ id: project.id, name: 'Nomad Coffee' });
			expect(d.card).toMatchObject({ status: 'active', mask: '5150 23** **** 4778', cardPageUrl: null });
			expect(d.charges).toMatchObject([{ amount: 1500, status: 'succeeded', reference: 'order-1' }]);
			expect(d.events.map((e: Any) => e.type)).toEqual(['card.saved']);
		});
	}

	it('charges and removes a saved card', async () => {
		const setup = await start();
		await handleBonumWebhook({ db, config: testConfig() }, cardToken(setup.id, 0.01));
		const at = (form: Record<string, string>) => event(`/admin/cards/${setup.id}`, form, { id: setup.id });

		expect(await call(cardActions.charge, at({ amount: '0', reference: 'r-1' }))).toMatchObject({ status: 400, data: { action: 'charge' } });
		fakeBonum({ [PURCHASE]: () => jsonResponse({ data: { id: 1, completedAt: '2026-01-13 11:55:44', status: 'SUCCESS' }, status: 200 }) });
		const res = call(cardActions.charge, at({ amount: '2500', reference: 'r-1' }));
		const [made] = await res.then(
			() => [],
			async (r: Any) => {
				expect(r.status).toBe(303);
				const rows = await db.select().from(charge);
				expect(r.location).toBe(`/admin/charges/${rows[0]!.id}`);
				return rows;
			}
		);
		expect(made).toMatchObject({ cardId: setup.id, amount: 2500, reference: 'r-1', status: 'succeeded' });

		expect(await call(cardActions.remove, at({ confirm: 'nope' }))).toMatchObject({ status: 400 });
		expect(await call(cardActions.remove, at({ confirm: 'user-1' }))).toEqual({ ok: true });
		const [row] = await db.select().from(card).where(eq(card.id, setup.id));
		expect(row).toMatchObject({ status: 'removed', tokenEnc: null });
		expect(await call(cardActions.charge, at({ amount: '2500', reference: 'r-2' }))).toMatchObject({ status: 409 });
	});
});
