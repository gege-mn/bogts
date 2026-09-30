import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compactJson } from '$lib/server/providers/bonum/checksum';
import { PAYMENT_SUCCESS, SUBSCRIPTION_PAYMENT, docJson } from '$lib/server/providers/bonum/fixtures';
import { sign } from '$lib/server/providers/bonum/testing';
import { invoice, subscription } from '$lib/server/schema';
import { createTestDb, seedPlan, seedProject, testConfig, type TestDb } from '$lib/server/testdb';
import type { Config } from '$lib/server/env';
import { POST } from './+server';

const KEY = testConfig().bonum!.checksumKey;
let db: TestDb;
let config: Config;
let projectId: string;

beforeEach(async () => {
	db = createTestDb();
	config = testConfig();
	projectId = (await seedProject(db)).project.id;
});
afterEach(() => vi.restoreAllMocks());

function post(body: string, headers: Record<string, string> = {}) {
	const request = new Request('https://payments.test/hooks/bonum', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
	const event = { request, locals: { db, config, waitUntil: () => {} } } as unknown as RequestEvent;
	return (POST as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

async function seedInvoice() {
	await db.insert(invoice).values({
		id: 'N998921',
		projectId,
		provider: 'bonum',
		amount: 10_000,
		reference: 'order-1',
		description: 'Order',
		expiresAt: Date.now() + 60_000,
		createdAt: Date.now(),
		updatedAt: Date.now()
	});
}

describe('POST /hooks/bonum', () => {
	it('verifies the raw bytes (decimals intact) and applies the payment', async () => {
		await seedInvoice();
		const res = await post(PAYMENT_SUCCESS, { 'x-checksum-v2': await sign(PAYMENT_SUCCESS, KEY) });
		expect(res.status).toBe(200);
		// JSON, in the shape of Bonum's own answers: its sender parses the reply.
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(await res.json()).toEqual({ status: 200, message: 'SUCCESS' });
		const [row] = await db.select().from(invoice).where(eq(invoice.id, 'N998921'));
		expect(row!.status).toBe('paid');
		// A replay is answered SUCCESS too, and changes nothing.
		const again = await post(PAYMENT_SUCCESS, { 'x-checksum-v2': await sign(compactJson(PAYMENT_SUCCESS), KEY) });
		expect(again.status).toBe(200);
	});

	it('refuses a bad checksum before parsing', async () => {
		await seedInvoice();
		const res = await post(PAYMENT_SUCCESS, { 'x-checksum-v2': await sign(PAYMENT_SUCCESS, 'wrong-key') });
		expect(res.status).toBe(401);
		expect((await db.select().from(invoice))[0]!.status).toBe('pending');
		expect((await post('not json', {})).status).toBe(401);
	});

	it('refuses a body over 64 KiB', async () => {
		const big = JSON.stringify({ type: 'PAYMENT', body: { pad: 'x'.repeat(70 * 1024) } });
		expect((await post(big, { 'x-checksum-v2': await sign(big, KEY) })).status).toBe(413);
	});

	it('answers 503 when processing fails, so Bonum retries', async () => {
		// A renewal before its CARD-TOKEN: retry later.
		const plan = await seedPlan(db, projectId, { providerPlanId: 4, amount: 3 });
		await db.insert(subscription).values({
			id: 'S1',
			projectId,
			planId: plan.id,
			customerRef: 'c',
			status: 'pending',
			tokenizeTransactionId: '20000007',
			createdAt: 1,
			updatedAt: 1
		});
		const body = docJson(SUBSCRIPTION_PAYMENT);
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const res = await post(body, { 'x-checksum-v2': await sign(body, KEY) });
		expect(res.status).toBe(503);
		expect(spy.mock.calls.flat().join(' ')).not.toContain('20000007');
	});

	it('answers 503 while Bonum is not configured', async () => {
		config = testConfig({ bonum: null, providers: { bonum: false, qpay: true } });
		expect((await post(PAYMENT_SUCCESS)).status).toBe(503);
	});
});
