/**
 * "The same purchase": when two invoices are one purchase asked for twice.
 *
 * Reuse (`openInvoice`), closing the other invoices once one is paid
 * (`cancelSiblings`) and the paid-twice flag (`settleInvoice`) all use this one
 * test. Two invoices are the same purchase only when the project, reference,
 * provider, amount, description, returnUrl, metadata and items ALL match
 * (metadata as canonical JSON, null equal to {}). A shared reference with different
 * contents is a different purchase: it is not reused, not cancelled, and not
 * flagged as paid twice.
 */
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { invoice as invoiceTable, type Invoice, type Metadata } from '../schema';

export type PurchaseFields = Pick<
	Invoice,
	'projectId' | 'reference' | 'provider' | 'amount' | 'description' | 'returnUrl' | 'metadata' | 'items'
>;

/** Metadata as JSON with sorted keys; null and {} are the same. */
export function canonicalMetadata(m: Metadata | null | undefined): string {
	if (!m) return '{}';
	return JSON.stringify(Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

export function samePurchase(a: PurchaseFields, b: PurchaseFields): boolean {
	return (
		a.projectId === b.projectId &&
		a.reference === b.reference &&
		a.provider === b.provider &&
		a.amount === b.amount &&
		a.description === b.description &&
		(a.returnUrl ?? null) === (b.returnUrl ?? null) &&
		canonicalMetadata(a.metadata) === canonicalMetadata(b.metadata) &&
		JSON.stringify(a.items ?? null) === JSON.stringify(b.items ?? null)
	);
}

/**
 * The SQL part of the test (everything but metadata), to narrow a query.
 * Rows it returns must still pass `samePurchase`.
 */
export function purchaseWhere(p: PurchaseFields): SQL {
	return and(
		eq(invoiceTable.projectId, p.projectId),
		eq(invoiceTable.reference, p.reference),
		eq(invoiceTable.provider, p.provider),
		eq(invoiceTable.amount, p.amount),
		eq(invoiceTable.description, p.description),
		p.returnUrl == null ? isNull(invoiceTable.returnUrl) : eq(invoiceTable.returnUrl, p.returnUrl)
	)!;
}
