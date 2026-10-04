/**
 * QPay's server-to-server callback (`/hooks/qpay/<invoiceId>`).
 *
 * It is public and unauthenticated, so nothing in the request is trusted: the
 * body, the query (QPay may append `?qpay_payment_id=`) and the headers are
 * never read; `processQpayCallback` does not even receive the request. The
 * path names which of OUR invoices to ask about, and the answer comes from
 * `payment/check` (the adapter's `check`). Only a verified PAID row of the
 * exact amount is settled, through `settleInvoice`, which makes a replay or a
 * race with the sweep a no-op. Money that arrives after expiry or cancel is
 * honoured. For an invoice already paid, the callback only looks again (at
 * most 3 times per 10 minutes) for a second payment or a refund.
 *
 * Answers: 200 `SUCCESS` for every outcome that retrying would not change
 * (settled, already paid, unpaid at re-check); 503 when we could not find out
 * (QPay or D1 down), so QPay calls again; 404 for an id that is not one of our
 * QPay invoices.
 */
import { eq } from 'drizzle-orm';
import { recordActivity } from '../../activity';
import { consumeRateLimit } from '../../rate-limit';
import { invoice as invoiceTable, type Invoice } from '../../schema';
import { nowOf, type ServiceContext } from '../../services/context';
import { settleInvoice } from '../../services/settle';
import { qpayInvoiceAdapter } from './invoice';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** At most this many provider re-checks per invoice per window: the endpoint is public. */
export const CALLBACK_CHECKS_PER_WINDOW = 20;
export const CALLBACK_WINDOW_MS = 10 * 60 * 1000;

export type CallbackOutcome = 'not_found' | 'already_paid' | 'settled' | 'duplicate' | 'unpaid' | 'throttled' | 'check_failed';

const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
	new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });

async function note(ctx: ServiceContext, inv: Invoice, kind: string, summary: string) {
	await recordActivity(
		ctx.db,
		{ projectId: inv.projectId, subjectType: 'invoice', subjectId: inv.id, source: 'provider', kind, summary },
		nowOf(ctx)
	);
}

/** A callback for an already paid invoice re-checks at most `PAID_RECHECKS_PER_WINDOW` times per this window. */
export const PAID_RECHECK_WINDOW_MS = 10 * 60 * 1000;
export const PAID_RECHECKS_PER_WINDOW = 3;
const paidKey = (id: string) => `qpay-callback-paid:${id}`;

/**
 * A callback for an invoice that is already paid most likely means the payer
 * paid the same QR again (or QPay replayed). Look, at most 3 times per 10
 * minutes per invoice, so the public endpoint stays no amplifier: the adapter's check
 * records a second PAID payment (`qpay.extra_payment`) or a refunded one
 * (`qpay.payment_refunded`). Nothing is settled again and nothing here fails
 * the callback.
 */
async function recheckPaid(ctx: ServiceContext, inv: Invoice): Promise<void> {
	try {
		const limit = await consumeRateLimit(ctx.db, paidKey(inv.id), PAID_RECHECKS_PER_WINDOW, PAID_RECHECK_WINDOW_MS, nowOf(ctx));
		if (!limit.ok) return;
		await qpayInvoiceAdapter.check!(ctx, inv);
	} catch {
		/* a hint about a paid invoice; the answer is SUCCESS either way */
	}
}

export async function processQpayCallback(ctx: ServiceContext, invoiceId: string): Promise<CallbackOutcome> {
	if (!ULID.test(invoiceId)) return 'not_found';
	const [inv] = await ctx.db.select().from(invoiceTable).where(eq(invoiceTable.id, invoiceId)).limit(1);
	if (!inv || inv.provider !== 'qpay') return 'not_found';
	if (inv.status === 'paid') {
		await recheckPaid(ctx, inv);
		return 'already_paid';
	}

	const limit = await consumeRateLimit(ctx.db, `qpay-callback:${inv.id}`, CALLBACK_CHECKS_PER_WINDOW, CALLBACK_WINDOW_MS, nowOf(ctx));
	if (!limit.ok) return 'throttled';

	let result: Awaited<ReturnType<NonNullable<typeof qpayInvoiceAdapter.check>>>;
	try {
		result = await qpayInvoiceAdapter.check!(ctx, inv);
	} catch (err) {
		await note(ctx, inv, 'qpay.callback.check_failed', `A QPay callback arrived but the payment check failed (${err instanceof Error ? err.name : 'error'}); QPay will retry.`);
		return 'check_failed';
	}
	if (!result.paid) {
		await note(ctx, inv, 'qpay.callback.unverified', 'A QPay callback arrived, but QPay reports no matching payment. Ignored.');
		return 'unpaid';
	}
	// Settling uses none of the paid re-checks: a second payment right after
	// this one is still looked for by the next callbacks.
	const settled = await settleInvoice(ctx, inv, result);
	if (settled === 'settled') {
		const late = inv.status === 'pending' ? '' : ` after the invoice was ${inv.status}; honoured`;
		await note(ctx, inv, 'qpay.callback.paid', `Paid, verified with QPay${late}.`);
		return 'settled';
	}
	await note(ctx, inv, 'qpay.callback.duplicate', 'A repeated QPay callback for a payment already recorded.');
	return 'duplicate';
}

/** A status poll (the hosted page's, or a project's `GET /v1/invoices/:id`) may ask QPay at most once per this, per invoice. */
export const POLL_CHECK_INTERVAL_MS = 10_000;

/**
 * A status poll (the hosted QR page's `/pay/:id/status`, or a project reading
 * `GET /v1/invoices/:id`): while a QPay invoice is
 * pending and not expired, ask QPay (at most once per 10 s per invoice) and
 * settle a verified payment exactly as the callback does, in case QPay's
 * callback is late or lost. Any failure just leaves the invoice pending.
 * Returns true when this call settled it.
 */
export async function pollQpayInvoice(ctx: ServiceContext, inv: Invoice): Promise<boolean> {
	const now = nowOf(ctx);
	if (inv.provider !== 'qpay' || inv.status !== 'pending' || inv.expiresAt <= now) return false;
	try {
		const limit = await consumeRateLimit(ctx.db, `qpay-poll:${inv.id}`, 1, POLL_CHECK_INTERVAL_MS, now);
		if (!limit.ok) return false;
		const result = await qpayInvoiceAdapter.check!(ctx, inv);
		if (!result.paid) return false;
		if ((await settleInvoice(ctx, inv, result)) !== 'settled') return false;
		await note(ctx, inv, 'qpay.poll.paid', 'Paid, verified with QPay on a status check while the payer waited.');
		return true;
	} catch {
		return false;
	}
}

/** The route's answer for an outcome. */
export function callbackResponse(outcome: CallbackOutcome): Response {
	switch (outcome) {
		case 'not_found':
			return text('NOT_FOUND', 404);
		case 'throttled':
		case 'check_failed':
			return text('RETRY', 503, { 'retry-after': '60' });
		default:
			return text('SUCCESS');
	}
}
