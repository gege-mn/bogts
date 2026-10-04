import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetQpayTokenCache } from '$lib/server/providers/qpay/client';
import { fakeQpay, type FakeQpay } from '$lib/server/providers/qpay/fake';
import { event, invoice, rateLimit } from '$lib/server/schema';
import { createTestDb, seedProject, testConfig, type TestDb } from '$lib/server/testdb';
import { STATUS_LIMIT } from '$lib/server/public/invoice-view';
import { GET as getStatus } from '../../pay/[invoiceId]/status/+server';
import { POST as cancel } from './[id]/cancel/+server';
import { GET as getOne } from './[id]/+server';
import { GET as list, POST as create } from './+server';

let db: TestDb;
let qpay: FakeQpay;
let apiKey: string;
const config = testConfig();

type Handler = (event: never) => Response | Promise<Response>;

function call(handler: Handler, path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string>; params?: Record<string, string> } = {}) {
	const url = new URL(`https://payments.test${path}`);
	const request = new Request(url, {
		method: opts.method ?? 'GET',
		headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...opts.headers },
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
	});
	const locals = { db, config, waitUntil: () => {} };
	const event = { url, request, params: opts.params ?? {}, locals, getClientAddress: () => '203.0.113.9' } as unknown as RequestEvent;
	return Promise.resolve(handler(event as never));
}

const body = { provider: 'qpay', amount: 49_900, reference: 'order-1', description: 'Pro plan', returnUrl: 'https://shop.test/done' };

beforeEach(async () => {
	resetQpayTokenCache();
	db = createTestDb();
	apiKey = (await seedProject(db)).apiKey;
	qpay = fakeQpay();
	vi.stubGlobal('fetch', qpay.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('/v1/invoices', () => {
	it('creates, reads, lists and cancels', async () => {
		const res = await call(create, '/v1/invoices', { method: 'POST', body });
		expect(res.status).toBe(201);
		const inv = (await res.json()) as { id: string; payUrl: string; status: string };
		expect(inv).toMatchObject({ object: 'invoice', status: 'pending', payUrl: `https://payments.test/pay/${inv.id}` });

		const one = await call(getOne, `/v1/invoices/${inv.id}`, { params: { id: inv.id } });
		expect(((await one.json()) as { id: string }).id).toBe(inv.id);

		const page = (await (await call(list, '/v1/invoices?reference=order-1&limit=5')).json()) as Record<string, unknown>;
		expect(page).toMatchObject({ object: 'list', hasMore: false, nextCursor: null });
		expect((page.data as unknown[]).length).toBe(1);

		const cancelled = await call(cancel, `/v1/invoices/${inv.id}/cancel`, { method: 'POST', params: { id: inv.id } });
		expect(((await cancelled.json()) as { status: string }).status).toBe('cancelled');
	});

	it('reading one pending QPay invoice asks QPay, at most once per 10 s, and settles a payment', async () => {
		const inv = (await (await call(create, '/v1/invoices', { method: 'POST', body })).json()) as { id: string };
		const read = async () => (await (await call(getOne, `/v1/invoices/${inv.id}`, { params: { id: inv.id } })).json()) as { status: string; paidAt: string | null };

		expect((await read()).status).toBe('pending');
		expect(qpay.count('POST /v2/payment/check')).toBe(1);
		// Inside the window the read answers from the database.
		expect((await read()).status).toBe('pending');
		expect(qpay.count('POST /v2/payment/check')).toBe(1);

		const [row] = await db.select().from(invoice);
		qpay.pay(row!.providerInvoiceId!, 49_900);
		await db.delete(rateLimit);
		const paid = await read();
		expect(paid.status).toBe('paid');
		expect(paid.paidAt).not.toBeNull();
		expect((await db.select().from(event)).map((e) => e.type)).toEqual(['invoice.paid']);
		// Paid: nothing left to ask.
		await db.delete(rateLimit);
		await read();
		expect(qpay.count('POST /v2/payment/check')).toBe(2);
	});

	it('answers 200 with the pending invoice for the same purchase, 201 for a new one', async () => {
		const first = await call(create, '/v1/invoices', { method: 'POST', body });
		expect(first.status).toBe(201);
		expect(first.headers.get('bogts-reused')).toBe('false');
		const again = await call(create, '/v1/invoices', { method: 'POST', body });
		expect(again.status).toBe(200);
		expect(again.headers.get('bogts-reused')).toBe('true');
		const [a, b] = [(await first.json()) as { id: string }, (await again.json()) as { id: string }];
		expect(b.id).toBe(a.id);
		const fresh = await call(create, '/v1/invoices', { method: 'POST', body: { ...body, reuse: false } });
		expect(fresh.status).toBe(201);
		expect(((await fresh.json()) as { id: string }).id).not.toBe(a.id);
		expect(qpay.count('POST /v2/invoice')).toBe(2);
	});

	it('replays a POST with the same Idempotency-Key', async () => {
		const headers = { 'idempotency-key': 'k-1' };
		const a = await call(create, '/v1/invoices', { method: 'POST', body, headers });
		const b = await call(create, '/v1/invoices', { method: 'POST', body, headers });
		expect(b.headers.get('idempotent-replayed')).toBe('true');
		expect([a.headers.get('bogts-reused'), b.headers.get('bogts-reused')]).toEqual(['false', 'false']);
		expect(((await a.json()) as { id: string }).id).toBe(((await b.json()) as { id: string }).id);
		expect(qpay.count('POST /v2/invoice')).toBe(1);
	});

	it('answers errors in the JSON shape', async () => {
		const bad = await call(create, '/v1/invoices', { method: 'POST', body: { ...body, amount: 0 } });
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
		apiKey = 'bgk_wrong';
		expect((await call(list, '/v1/invoices')).status).toBe(401);
	});
});

describe('/pay/:id/status', () => {
	it('exposes only status, paidAt and returnUrl', async () => {
		const inv = (await (await call(create, '/v1/invoices', { method: 'POST', body })).json()) as { id: string };
		const res = await call(getStatus, `/pay/${inv.id}/status`, { params: { invoiceId: inv.id }, headers: { authorization: '' } });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'pending', paidAt: null, returnUrl: 'https://shop.test/done' });
		const missing = await call(getStatus, '/pay/x/status', { params: { invoiceId: 'x' } });
		expect(missing.status).toBe(404);
	});

	it('rate-limits per address', async () => {
		let last = 0;
		for (let i = 0; i <= STATUS_LIMIT; i++) {
			last = (await call(getStatus, '/pay/01J00000000000000000000000/status', { params: { invoiceId: '01J00000000000000000000000' } })).status;
		}
		expect(last).toBe(429);
	});
});
