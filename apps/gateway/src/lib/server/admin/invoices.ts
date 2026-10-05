/** Dashboard reads for payments (invoices). */
import { asc, count, desc, eq, gt, lt } from 'drizzle-orm';
import { batchSelect, type DB } from '../db';
import { INVOICE_STATUSES, PROVIDERS, invoice, project, type InvoiceStatus, type Provider } from '../schema';
import { all, finishPage, PAGE_SIZE, scoped, subjectEventsFrom, subjectEventsStatements, type Cursor, type Page } from './common';
import { timelineFrom, timelineStatements, type TimelineEntry } from './timeline';

export const INVOICE_TILES = ['paid', 'pending', 'expired', 'failed'] as const;

export type InvoiceFilter = {
	projectId: string | null;
	status?: InvoiceStatus | null;
	provider?: Provider | null;
	/** The project's own reference, exact (e.g. "Needs attention" → a reference paid twice) */
	reference?: string | null;
};

const referenceParam = (v: string | null) => (v && v.length <= 255 ? v : null);

export function invoiceFilterFrom(url: URL, projectId: string | null): InvoiceFilter {
	const s = url.searchParams.get('status');
	const p = url.searchParams.get('provider');
	return {
		projectId,
		status: (INVOICE_STATUSES as readonly string[]).includes(s ?? '') ? (s as InvoiceStatus) : null,
		provider: (PROVIDERS as readonly string[]).includes(p ?? '') ? (p as Provider) : null,
		reference: referenceParam(url.searchParams.get('reference'))
	};
}

export type InvoiceRow = {
	id: string;
	projectId: string;
	projectName: string;
	provider: Provider;
	amount: number;
	status: InvoiceStatus;
	reference: string;
	description: string;
	createdAt: number;
	paidAt: number | null;
	expiresAt: number;
};

function listInvoicesQuery(db: DB, f: InvoiceFilter, cursor: Cursor) {
	return db
		.select(
			batchSelect({
				id: invoice.id,
				projectId: invoice.projectId,
				projectName: project.name,
				provider: invoice.provider,
				amount: invoice.amount,
				status: invoice.status,
				reference: invoice.reference,
				description: invoice.description,
				createdAt: invoice.createdAt,
				paidAt: invoice.paidAt,
				expiresAt: invoice.expiresAt
			})
		)
		.from(invoice)
		.innerJoin(project, eq(project.id, invoice.projectId))
		.where(
			all(
				scoped(invoice.projectId, f.projectId),
				f.status ? eq(invoice.status, f.status) : undefined,
				f.provider ? eq(invoice.provider, f.provider) : undefined,
				f.reference ? eq(invoice.reference, f.reference) : undefined,
				cursor.before ? lt(invoice.id, cursor.before) : undefined,
				cursor.after ? gt(invoice.id, cursor.after) : undefined
			)
		)
		.orderBy(cursor.after ? asc(invoice.id) : desc(invoice.id))
		.limit(PAGE_SIZE + 1);
}

export async function listInvoices(db: DB, f: InvoiceFilter, cursor: Cursor = {}): Promise<Page<InvoiceRow>> {
	return finishPage(await listInvoicesQuery(db, f, cursor), cursor);
}

function invoiceCountsQuery(db: DB, f: InvoiceFilter) {
	return db
		.select(batchSelect({ status: invoice.status, n: count() }))
		.from(invoice)
		.where(
			all(
				scoped(invoice.projectId, f.projectId),
				f.provider ? eq(invoice.provider, f.provider) : undefined,
				f.reference ? eq(invoice.reference, f.reference) : undefined
			)
		)
		.groupBy(invoice.status);
}

function invoiceCountsFrom(rows: { status: InvoiceStatus; n: number }[]): Record<string, number> {
	const out: Record<string, number> = { all: 0 };
	for (const r of rows) {
		out[r.status] = r.n;
		out.all = (out.all ?? 0) + r.n;
	}
	return out;
}

/** Counts per status for the tiles (same scope and provider filter, any status). */
export async function invoiceCounts(db: DB, f: InvoiceFilter): Promise<Record<string, number>> {
	return invoiceCountsFrom(await invoiceCountsQuery(db, f));
}

/** The payments list and its tiles in one round trip. */
export async function invoicesPage(db: DB, f: InvoiceFilter, cursor: Cursor = {}) {
	const [rows, counts] = await db.batch([listInvoicesQuery(db, f, cursor), invoiceCountsQuery(db, f)]);
	return { page: finishPage(rows, cursor), counts: invoiceCountsFrom(counts) };
}

/** The payment page in one round trip: everything after the invoice row is read by its id. */
export async function getInvoiceDetail(db: DB, id: string) {
	const [[row], eventRows, deliveryRows, ...timelineRows] = await db.batch([
		db
			.select(batchSelect({ invoice, project: { id: project.id, name: project.name, webhookUrl: project.webhookUrl } }))
			.from(invoice)
			.innerJoin(project, eq(project.id, invoice.projectId))
			.where(eq(invoice.id, id))
			.limit(1),
		...subjectEventsStatements(db, [id]),
		...timelineStatements(db, 'invoice', [id])
	]);
	if (!row) return null;
	const inv = row.invoice;
	const events = subjectEventsFrom([eventRows, deliveryRows]);
	const extra: TimelineEntry[] = [
		{
			key: 'created',
			at: inv.createdAt,
			source: 'gateway',
			title: 'Invoice created',
			detail: inv.providerInvoiceId ? `sent to the provider · ${inv.providerInvoiceId}` : null,
			href: null
		}
	];
	if (inv.sweptAt) {
		extra.push({
			key: 'swept',
			at: inv.sweptAt,
			source: 'gateway',
			title: 'Expiry check',
			detail: inv.status === 'paid' ? 'found paid' : `marked ${inv.status}`,
			href: null
		});
	}
	const timeline = timelineFrom(timelineRows, { subjectType: 'invoice', events, extra });
	return {
		invoice: {
			id: inv.id,
			provider: inv.provider,
			amount: inv.amount,
			items: inv.items,
			status: inv.status,
			reference: inv.reference,
			description: inv.description,
			providerInvoiceId: inv.providerInvoiceId,
			providerTransactionId: inv.providerTransactionId,
			redirectUrl: inv.redirectUrl,
			hasQr: !!(inv.qrImage || inv.qrText),
			returnUrl: inv.returnUrl,
			expiresAt: inv.expiresAt,
			sweptAt: inv.sweptAt,
			paidAt: inv.paidAt,
			metadata: inv.metadata,
			createdAt: inv.createdAt
		},
		project: row.project,
		events,
		timeline
	};
}
