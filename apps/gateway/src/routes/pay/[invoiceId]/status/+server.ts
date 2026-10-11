/**
 * `GET /pay/:invoiceId/status`: what the hosted QR page polls. Public, so it
 * answers only `{ status, paidAt, returnUrl }`. QPay's callback and the sweep
 * settle invoices; while a QPay invoice is pending and not expired, this also
 * asks QPay at most once per 10 s per invoice, in case the callback is late.
 */
import { eq } from 'drizzle-orm';
import { errorJson, handle, json } from '$lib/server/api/errors';
import { deliverFresh } from '$lib/server/events/deliver';
import { notifyFresh } from '$lib/server/notify/dispatch';
import { pollQpayInvoice } from '$lib/server/providers/qpay/callback';
import { ipRateKey } from '$lib/server/ip';
import { safeReturnUrl, STATUS_LIMIT } from '$lib/server/public/invoice-view';
import { rateLimitHit, rateLimitResult } from '$lib/server/rate-limit';
import { invoice } from '$lib/server/schema';
import type { RequestHandler } from './$types';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const STATUS_WINDOW_MS = 60_000;

export const GET: RequestHandler = handle(async ({ locals, params, getClientAddress }) => {
	if (!ULID.test(params.invoiceId)) return errorJson(404, 'not_found', 'Invoice not found');
	let address = '';
	try {
		address = getClientAddress();
	} catch {
		/* no address in this environment: one shared bucket */
	}
	// The hit and the read in one round trip (the payer's page polls this).
	const now = Date.now();
	const [hit, rows] = await locals.db.batch([
		rateLimitHit(locals.db, `pay-status:${ipRateKey(address)}`, STATUS_WINDOW_MS, now),
		locals.db.select().from(invoice).where(eq(invoice.id, params.invoiceId)).limit(1)
	]);
	const limit = rateLimitResult(hit, STATUS_LIMIT, STATUS_WINDOW_MS, now);
	if (!limit.ok) {
		const retry = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000));
		return errorJson(429, 'rate_limited', 'Too many requests', { 'retry-after': String(retry) });
	}
	let [row] = rows;
	if (!row) return errorJson(404, 'not_found', 'Invoice not found');
	if (locals.config) {
		const ctx = { db: locals.db, config: locals.config, waitUntil: locals.waitUntil };
		if (await pollQpayInvoice(ctx, row)) {
			row = (await locals.db.select().from(invoice).where(eq(invoice.id, params.invoiceId)).limit(1))[0] ?? row;
			locals.waitUntil(deliverFresh(ctx));
			locals.waitUntil(notifyFresh(ctx));
		}
	}
	return json({
		status: row.status,
		paidAt: row.paidAt === null ? null : new Date(row.paidAt).toISOString(),
		returnUrl: safeReturnUrl(row.returnUrl)
	});
});
