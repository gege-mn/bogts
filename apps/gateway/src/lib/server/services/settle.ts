/**
 * The only way an invoice becomes paid, expired or failed.
 *
 * Payment is written as one D1 batch: the ledger row (UNIQUE provider +
 * providerRef), the invoice update and the `invoice.paid` event with its
 * delivery. A replayed webhook, a callback racing the sweep, or two isolates
 * receiving the same notification all collide on the ledger's unique index, so
 * the batch rolls back whole and the caller gets 'duplicate'. Money that
 * arrives for an expired or cancelled invoice is still honoured: it becomes
 * paid, because the payer's money has moved.
 *
 * One purchase, several invoices (`samePurchase`: project, reference,
 * provider, amount, description, returnUrl and metadata all equal; a shared
 * reference with different contents is a different purchase):
 *  - Once one is paid, the others still pending are cancelled, in the
 *    background (`waitUntil`, or inline after the commit when there is none),
 *    so a failed cancel never fails the settlement: `cancelled` with NO event
 *    (like a project's own cancel), for QPay only once QPay confirmed the
 *    cancel (else it stays pending for the expiry check). Money that still
 *    reaches one is honoured.
 *  - If a second one is paid anyway, it is settled and `invoice.paid` is
 *    emitted (the money moved) with `duplicateOfInvoiceId` naming the one paid
 *    first, and `invoice.duplicate_payment` activity is recorded for the
 *    dashboard's "Needs attention". Two settling at the same instant may both
 *    miss the field; the activity is written after the commit, so it is not.
 */
import { and, asc, eq, isNotNull, ne } from 'drizzle-orm';
import { recordActivity } from '../activity';
import { eventInserts, type InvoiceEventData } from '../events/emit';
import { newId } from '../ids';
import { event, invoice as invoiceTable, ledger, type Invoice } from '../schema';
import { nowOf, type ServiceContext } from './context';
import { invoiceAdapters } from './invoice-adapters';
import { purchaseWhere, samePurchase } from './purchase';

export type SettleResult = 'settled' | 'duplicate' | 'amount_mismatch';

function eventData(inv: Invoice, paidAt?: number, duplicateOf?: string): InvoiceEventData {
	return {
		invoiceId: inv.id,
		provider: inv.provider,
		reference: inv.reference,
		amount: inv.amount,
		currency: 'MNT' as const,
		...(paidAt !== undefined ? { paidAt } : {}),
		metadata: inv.metadata ?? null,
		...(inv.items ? { items: inv.items } : {}),
		...(duplicateOf ? { duplicateOfInvoiceId: duplicateOf } : {})
	};
}

function paidSiblingsQuery(ctx: ServiceContext, inv: Invoice) {
	return ctx.db
		.select()
		.from(invoiceTable)
		.where(and(purchaseWhere(inv), eq(invoiceTable.status, 'paid'), ne(invoiceTable.id, inv.id), isNotNull(invoiceTable.paidAt)))
		.orderBy(asc(invoiceTable.paidAt), asc(invoiceTable.id));
}

const firstPaidSiblingFrom = (rows: Invoice[], inv: Invoice): { id: string } | undefined => {
	const row = rows.find((r) => samePurchase(r, inv));
	return row ? { id: row.id } : undefined;
};

/** The first-paid other invoice for the same purchase (`samePurchase`), if any. */
async function firstPaidSibling(ctx: ServiceContext, inv: Invoice): Promise<{ id: string } | undefined> {
	return firstPaidSiblingFrom(await paidSiblingsQuery(ctx, inv), inv);
}

async function note(ctx: ServiceContext, inv: Pick<Invoice, 'id' | 'projectId'>, kind: string, summary: string) {
	try {
		await recordActivity(
			ctx.db,
			{ projectId: inv.projectId, subjectType: 'invoice', subjectId: inv.id, source: 'gateway', kind, summary },
			nowOf(ctx)
		);
	} catch {
		/* the timeline is best effort; the payment is recorded */
	}
}

const errorCode = (err: unknown) =>
	err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(err.code)
		? err.code
		: err instanceof Error
			? err.name
			: 'error';

/**
 * Cancels the other PENDING invoices of `paid`'s purchase (`samePurchase`). A
 * provider that can cancel (QPay) is asked first, and only when it confirms is
 * the invoice cancelled here (a conditional update); if it refuses or errors,
 * the invoice stays pending (`invoice.provider_cancel_failed`), so the
 * at-expiry sweep still checks it. A provider without cancel (Bonum) is
 * cancelled locally. No event: the purchase is settled by `paid`'s
 * `invoice.paid`. Never rejects.
 */
export async function cancelSiblings(ctx: ServiceContext, paid: Invoice): Promise<number> {
	let cancelled = 0;
	try {
		const siblings = await ctx.db
			.select()
			.from(invoiceTable)
			.where(and(purchaseWhere(paid), eq(invoiceTable.status, 'pending'), ne(invoiceTable.id, paid.id)));
		for (const sib of siblings) {
			if (!samePurchase(sib, paid)) continue;
			try {
				// A provider that can cancel (QPay) must confirm it first: an invoice it
				// refused to cancel stays pending, so the at-expiry check still asks about it.
				const cancel = invoiceAdapters[sib.provider].cancel;
				if (cancel && sib.providerInvoiceId) {
					try {
						await cancel(ctx, sib);
					} catch (err) {
						await note(
							ctx,
							sib,
							'invoice.provider_cancel_failed',
							`Invoice ${paid.id} for the same purchase was paid, but the provider did not confirm cancelling this one (${errorCode(err)}); left pending, so its expiry check still asks about it.`
						);
						continue;
					}
				}
				const claimed = await ctx.db
					.update(invoiceTable)
					.set({ status: 'cancelled', updatedAt: nowOf(ctx) })
					.where(and(eq(invoiceTable.id, sib.id), eq(invoiceTable.status, 'pending')))
					.returning({ id: invoiceTable.id });
				if (claimed.length !== 1) continue;
				cancelled++;
				await note(ctx, sib, 'invoice.superseded', `Cancelled: invoice ${paid.id} for the same purchase was paid. A payment that still arrives here is honoured.`);
			} catch (err) {
				console.error('[settle] sibling cancel failed', sib.id, err instanceof Error ? err.name : typeof err);
			}
		}
	} catch (err) {
		console.error('[settle] sibling lookup failed', paid.id, err instanceof Error ? err.name : typeof err);
	}
	return cancelled;
}

/** After a settlement committed: flag a second payment for the purchase, then close its other invoices. */
async function afterSettled(ctx: ServiceContext, inv: Invoice, duplicateOf: string | undefined): Promise<void> {
	try {
		const first = duplicateOf ?? (await firstPaidSibling(ctx, inv))?.id;
		if (first) {
			await note(
				ctx,
				inv,
				'invoice.duplicate_payment',
				`Reference ${inv.reference.slice(0, 80)} was already paid by invoice ${first}: the payer paid twice. Refund one.`
			);
		}
	} catch {
		/* best effort */
	}
	const task = cancelSiblings(ctx, inv);
	if (ctx.waitUntil) ctx.waitUntil(task);
	else await task;
}

function ledgerQuery(ctx: ServiceContext, provider: Invoice['provider'], providerRef: string) {
	return ctx.db
		.select({ id: ledger.id })
		.from(ledger)
		.where(and(eq(ledger.provider, provider), eq(ledger.providerRef, providerRef)))
		.limit(1);
}

async function ledgerExists(ctx: ServiceContext, provider: Invoice['provider'], providerRef: string) {
	const [row] = await ledgerQuery(ctx, provider, providerRef);
	return !!row;
}

export async function settleInvoice(
	ctx: ServiceContext,
	inv: Invoice,
	payment: { providerRef: string; amount: number; paidAt?: number }
): Promise<SettleResult> {
	if (!payment.providerRef) throw new Error('settleInvoice: providerRef is required');
	if (payment.amount !== inv.amount) return 'amount_mismatch';
	// Both reads in one round trip.
	const [recorded, paidSiblings] = await ctx.db.batch([ledgerQuery(ctx, inv.provider, payment.providerRef), paidSiblingsQuery(ctx, inv)]);
	if (recorded.length > 0) return 'duplicate';
	const now = nowOf(ctx);
	const paidAt = payment.paidAt ?? now;
	const duplicateOf = firstPaidSiblingFrom(paidSiblings, inv)?.id;
	const { statements } = eventInserts(
		ctx.db,
		{
			projectId: inv.projectId,
			type: 'invoice.paid',
			subjectId: inv.id,
			data: eventData(inv, paidAt, duplicateOf),
			dedupeKey: `invoice.paid:${inv.id}`
		},
		now
	);
	try {
		await ctx.db.batch([
			ctx.db.insert(ledger).values({
				id: newId(),
				projectId: inv.projectId,
				provider: inv.provider,
				providerRef: payment.providerRef,
				kind: 'invoice',
				subjectId: inv.id,
				amount: payment.amount,
				createdAt: now
			}),
			ctx.db
				.update(invoiceTable)
				.set({ status: 'paid', paidAt, providerTransactionId: payment.providerRef, updatedAt: now })
				.where(and(eq(invoiceTable.id, inv.id), ne(invoiceTable.status, 'paid'))),
			...statements
		]);
	} catch (error) {
		// A concurrent writer won the unique ledger row (or the invoice.paid
		// dedupe key): the whole batch rolled back, and the payment is recorded once.
		if (await ledgerExists(ctx, inv.provider, payment.providerRef)) return 'duplicate';
		const [current] = await ctx.db
			.select({ status: invoiceTable.status })
			.from(invoiceTable)
			.where(eq(invoiceTable.id, inv.id))
			.limit(1);
		if (current?.status === 'paid') return 'duplicate';
		throw error;
	}
	await afterSettled(ctx, { ...inv, status: 'paid', paidAt }, duplicateOf);
	return 'settled';
}

/**
 * Ends an unpaid invoice as expired or failed and tells the project once.
 * Returns false when the invoice was already final (paid, or ended before).
 */
export async function endInvoice(
	ctx: ServiceContext,
	inv: Invoice,
	status: 'expired' | 'failed',
	opts: { swept?: boolean } = {}
): Promise<boolean> {
	const now = nowOf(ctx);
	const updated = await ctx.db
		.update(invoiceTable)
		.set({ status, updatedAt: now, ...(opts.swept ? { sweptAt: now } : {}) })
		.where(and(eq(invoiceTable.id, inv.id), eq(invoiceTable.status, 'pending')))
		.returning({ id: invoiceTable.id });
	if (updated.length !== 1) return false;
	const { statements } = eventInserts(
		ctx.db,
		{
			projectId: inv.projectId,
			type: status === 'expired' ? 'invoice.expired' : 'invoice.failed',
			subjectId: inv.id,
			data: eventData(inv),
			dedupeKey: `invoice.${status}:${inv.id}`
		},
		now
	);
	try {
		await ctx.db.batch(statements);
	} catch (error) {
		// Only a concurrent emit of the same dedupe key is harmless.
		const [existing] = await ctx.db
			.select({ id: event.id })
			.from(event)
			.where(eq(event.dedupeKey, `invoice.${status}:${inv.id}`))
			.limit(1);
		if (!existing) throw error;
	}
	return true;
}
