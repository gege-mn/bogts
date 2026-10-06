/**
 * One-off invoices, provider-agnostic: what `/v1/invoices` calls.
 *
 * Creating: validate, insert our row first (so the id exists before the
 * provider hears of it: QPay's `sender_invoice_no` and callback URL carry it),
 * call the provider's adapter, store what it answered. If the provider fails,
 * the row ends as `failed` (with its `invoice.failed` event) and the caller
 * gets `provider_error`.
 *
 * Payment, expiry and failure are written only by `services/settle.ts`.
 */
import { and, desc, eq, gt, isNotNull, lt, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { recordActivity } from '../activity';
import { ApiError, describeZodError, notFound } from '../api/errors';
import type { Config } from '../env';
import { QpayCallError } from '../providers/qpay/client';
import { newId } from '../ids';
import {
	INVOICE_STATUSES,
	PROVIDERS,
	invoice as invoiceTable,
	type Deeplink,
	type Invoice,
	type LineItem,
	type Metadata,
	type Project,
	type Provider
} from '../schema';
import { nowOf, type ServiceContext } from './context';
import { cursorSchema } from './paging';
import type { InvoiceAdapter } from './invoice-adapter';
import { priceFields, priceOf } from './items';
import { invoiceAdapters } from './invoice-adapters';
import { purchaseWhere, samePurchase, type PurchaseFields } from './purchase';
import { endInvoice, settleInvoice } from './settle';

export { invoiceAdapters };

export const DEFAULT_EXPIRES_IN = 1800;
export const MIN_EXPIRES_IN = 60;
export const MAX_EXPIRES_IN = 86_400;

const MAX_METADATA_KEYS = 20;

const metadataSchema = z
	.record(z.string().min(1).max(40), z.string().max(500))
	.refine((m) => Object.keys(m).length <= MAX_METADATA_KEYS, { message: `At most ${MAX_METADATA_KEYS} keys` });

/** `POST /v1/invoices` body (docs/contracts.md). */
export const createInvoiceSchema = z.object({
	provider: z.enum(PROVIDERS),
	/** Send `amount`, or `items` (lines that add up to it; a discount is a negative line) */
	...priceFields,
	reference: z.string().trim().min(1).max(255),
	description: z.string().trim().min(1).max(255),
	returnUrl: z.url({ protocol: /^https?$/ }).max(2048).nullish(),
	expiresIn: z.number().int().min(MIN_EXPIRES_IN).max(MAX_EXPIRES_IN).default(DEFAULT_EXPIRES_IN),
	metadata: metadataSchema.nullish(),
	/** false: always create a new invoice, never hand back a pending one for the same reference */
	reuse: z.boolean().default(true)
});
export type CreateInvoiceInput = z.input<typeof createInvoiceSchema>;
/** The parsed body with its price worked out (`priceOf`). */
type InvoiceData = Omit<z.output<typeof createInvoiceSchema>, 'amount' | 'items'> & { amount: number; items: LineItem[] | null };

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** `GET /v1/invoices` query. */
export const listInvoicesSchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(20),
	cursor: cursorSchema.optional(),
	reference: z.string().min(1).max(255).optional(),
	status: z.enum(INVOICE_STATUSES).optional()
});
export type ListInvoicesQuery = z.input<typeof listInvoicesSchema>;

export type InvoiceJson = {
	id: string;
	object: 'invoice';
	provider: Provider;
	status: Invoice['status'];
	amount: number;
	currency: 'MNT';
	reference: string;
	description: string;
	payUrl: string | null;
	redirectUrl: string | null;
	qr: { text: string; image: string | null } | null;
	deeplinks: Deeplink[];
	returnUrl: string | null;
	expiresAt: string;
	paidAt: string | null;
	metadata: Metadata | null;
	items: LineItem[] | null;
	createdAt: string;
};

const iso = (ms: number) => new Date(ms).toISOString();

/** The public Invoice shape. */
export function invoiceJson(inv: Invoice, config: Config): InvoiceJson {
	const payUrl =
		inv.provider === 'qpay'
			? config.publicOrigin
				? `${config.publicOrigin}/pay/${inv.id}`
				: null
			: (inv.redirectUrl ?? null);
	return {
		id: inv.id,
		object: 'invoice',
		provider: inv.provider,
		status: inv.status,
		amount: inv.amount,
		currency: 'MNT',
		reference: inv.reference,
		description: inv.description,
		payUrl,
		redirectUrl: inv.redirectUrl ?? null,
		qr: inv.qrText ? { text: inv.qrText, image: inv.qrImage ?? null } : null,
		deeplinks: inv.deeplinks ?? [],
		returnUrl: inv.returnUrl ?? null,
		expiresAt: iso(inv.expiresAt),
		paidAt: inv.paidAt === null ? null : iso(inv.paidAt),
		metadata: inv.metadata ?? null,
		items: inv.items ?? null,
		createdAt: iso(inv.createdAt)
	};
}

function safeCode(err: unknown): string {
	if (err instanceof QpayCallError) return `${err.operation} ${err.code}`;
	if (err instanceof ApiError) return err.code;
	return err instanceof Error ? err.name : 'unknown';
}

async function readInvoice(ctx: ServiceContext, id: string): Promise<Invoice | undefined> {
	const [row] = await ctx.db.select().from(invoiceTable).where(eq(invoiceTable.id, id)).limit(1);
	return row;
}

/**
 * A pending invoice handed back instead of a new one must still have this long
 * to run: a QR about to expire invites a payment that lands after expiry.
 */
export const REUSE_MIN_REMAINING_MS = 60_000;

/** How many candidate rows `reusable` looks at (it filters metadata in code). */
const REUSE_CANDIDATES = 20;

/**
 * The project's pending, unexpired invoice for the same purchase
 * (`samePurchase`: reference, provider, amount, description, returnUrl,
 * metadata and items all equal), if any: a second click on "Pay" should show the same
 * QR, not a second invoice the payer might also pay. Only an invoice the
 * provider accepted (it has a provider id) is reused; the newest wins.
 */
async function reusable(ctx: ServiceContext, projectId: string, data: InvoiceData) {
	const wanted: PurchaseFields = {
		projectId,
		reference: data.reference,
		provider: data.provider,
		amount: data.amount,
		description: data.description,
		returnUrl: data.returnUrl ?? null,
		metadata: data.metadata ?? null,
		items: data.items
	};
	const rows = await ctx.db
		.select()
		.from(invoiceTable)
		.where(
			and(
				purchaseWhere(wanted),
				eq(invoiceTable.status, 'pending'),
				gt(invoiceTable.expiresAt, nowOf(ctx) + REUSE_MIN_REMAINING_MS),
				isNotNull(invoiceTable.providerInvoiceId)
			)
		)
		.orderBy(desc(invoiceTable.id))
		.limit(REUSE_CANDIDATES);
	return rows.find((row) => samePurchase(row, wanted));
}

/**
 * `POST /v1/invoices`: a new invoice, or (unless `reuse: false`) the project's
 * pending, unexpired invoice for the same purchase (reference, provider,
 * amount, description, returnUrl and metadata all equal, see `samePurchase`).
 * `reused` tells the route to answer 200 instead of 201. The reused invoice is returned as it is (its
 * `expiresAt` is not extended).
 */
export async function openInvoice(
	ctx: ServiceContext,
	project: Pick<Project, 'id'>,
	input: CreateInvoiceInput
): Promise<{ invoice: Invoice; reused: boolean }> {
	const parsed = createInvoiceSchema.safeParse(input);
	if (!parsed.success) throw new ApiError(400, 'invalid_request', describeZodError(parsed.error));
	const data: InvoiceData = { ...parsed.data, ...priceOf(parsed.data) };
	if (!ctx.config.providers[data.provider]) {
		throw new ApiError(400, 'provider_disabled', `${data.provider === 'qpay' ? 'QPay' : 'Bonum'} is not enabled on this gateway`);
	}
	if (data.reuse) {
		const existing = await reusable(ctx, project.id, data);
		if (existing) return { invoice: existing, reused: true };
	}
	return { invoice: await insertAndCreate(ctx, project, data), reused: false };
}

async function insertAndCreate(
	ctx: ServiceContext,
	project: Pick<Project, 'id'>,
	data: InvoiceData
): Promise<Invoice> {
	const now = nowOf(ctx);
	const id = newId();
	const [row] = await ctx.db
		.insert(invoiceTable)
		.values({
			id,
			projectId: project.id,
			provider: data.provider,
			amount: data.amount,
			reference: data.reference,
			description: data.description,
			status: 'pending',
			returnUrl: data.returnUrl ?? null,
			expiresAt: now + data.expiresIn * 1000,
			metadata: data.metadata ?? null,
			items: data.items,
			createdAt: now,
			updatedAt: now
		})
		.returning();
	if (!row) throw new Error('invoice insert returned nothing');

	let created: Awaited<ReturnType<InvoiceAdapter['create']>>;
	try {
		created = await invoiceAdapters[data.provider].create(ctx, row);
	} catch (err) {
		await endInvoiceFailed(ctx, row, err);
		if (err instanceof ApiError && (err.code === 'provider_error' || err.code === 'provider_disabled')) throw err;
		throw new ApiError(502, 'provider_error', 'The payment provider could not create the invoice. Try again.');
	}

	const [stored] = await ctx.db
		.update(invoiceTable)
		.set({
			providerInvoiceId: created.providerInvoiceId,
			redirectUrl: created.redirectUrl ?? null,
			qrText: created.qrText ?? null,
			qrImage: created.qrImage ?? null,
			deeplinks: created.deeplinks ?? null,
			updatedAt: nowOf(ctx)
		})
		.where(eq(invoiceTable.id, id))
		.returning();
	if (!stored) throw new Error('invoice update returned nothing');
	return stored;
}

async function endInvoiceFailed(ctx: ServiceContext, row: Invoice, err: unknown): Promise<void> {
	await endInvoice(ctx, row, 'failed');
	await recordActivity(
		ctx.db,
		{
			projectId: row.projectId,
			subjectType: 'invoice',
			subjectId: row.id,
			source: 'gateway',
			kind: 'invoice.create_failed',
			summary: `The provider did not create the invoice (${safeCode(err)}).`
		},
		nowOf(ctx)
	);
}

export async function getInvoice(ctx: ServiceContext, projectId: string, id: string): Promise<Invoice> {
	if (!ULID.test(id)) throw notFound('Invoice');
	const [row] = await ctx.db
		.select()
		.from(invoiceTable)
		.where(and(eq(invoiceTable.id, id), eq(invoiceTable.projectId, projectId)))
		.limit(1);
	if (!row) throw notFound('Invoice');
	return row;
}

/** Newest first; `nextCursor` is the last id of the page. */
export async function listInvoices(
	ctx: ServiceContext,
	projectId: string,
	q: ListInvoicesQuery = {}
): Promise<{ data: Invoice[]; hasMore: boolean; nextCursor: string | null }> {
	const parsed = listInvoicesSchema.safeParse(q);
	if (!parsed.success) throw new ApiError(400, 'invalid_request', describeZodError(parsed.error));
	const { limit, cursor, reference, status } = parsed.data;
	const where: SQL[] = [eq(invoiceTable.projectId, projectId)];
	if (cursor) where.push(lt(invoiceTable.id, cursor));
	if (reference) where.push(eq(invoiceTable.reference, reference));
	if (status) where.push(eq(invoiceTable.status, status));
	const rows = await ctx.db
		.select()
		.from(invoiceTable)
		.where(and(...where))
		.orderBy(desc(invoiceTable.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const data = hasMore ? rows.slice(0, limit) : rows;
	return { data, hasMore, nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null };
}

/**
 * Cancels a pending invoice. For a provider that can say whether it was paid
 * (QPay), it asks first: an invoice paid while its callback was lost is
 * settled, not cancelled, and the call answers 409. If the provider cannot
 * answer, nothing is cancelled (502): retiring an invoice whose payment state
 * is unknown is how a payer ends up paying twice. The provider-side cancel is
 * best effort; money that still arrives is honoured.
 */
export async function cancelInvoice(ctx: ServiceContext, projectId: string, id: string): Promise<Invoice> {
	const inv = await getInvoice(ctx, projectId, id);
	if (inv.status !== 'pending') {
		throw new ApiError(409, 'conflict', `The invoice is ${inv.status} and cannot be cancelled`);
	}
	const adapter = invoiceAdapters[inv.provider];
	if (adapter.check && inv.providerInvoiceId) {
		let result: Awaited<ReturnType<NonNullable<InvoiceAdapter['check']>>>;
		try {
			result = await adapter.check(ctx, inv);
		} catch {
			throw new ApiError(502, 'provider_error', 'Could not confirm with the provider that the invoice is unpaid. Try again.');
		}
		if (result.paid) {
			await settleInvoice(ctx, inv, result);
			throw new ApiError(409, 'conflict', 'The invoice has already been paid');
		}
	}
	if (adapter.cancel) {
		try {
			await adapter.cancel(ctx, inv);
		} catch (err) {
			await recordActivity(
				ctx.db,
				{
					projectId: inv.projectId,
					subjectType: 'invoice',
					subjectId: inv.id,
					source: 'gateway',
					kind: 'invoice.provider_cancel_failed',
					summary: `The provider did not confirm the cancel (${safeCode(err)}); a payment that still arrives is honoured.`
				},
				nowOf(ctx)
			);
		}
	}
	const now = nowOf(ctx);
	const [updated] = await ctx.db
		.update(invoiceTable)
		.set({ status: 'cancelled', updatedAt: now })
		.where(and(eq(invoiceTable.id, inv.id), eq(invoiceTable.status, 'pending')))
		.returning();
	if (!updated) {
		const current = await readInvoice(ctx, inv.id);
		throw new ApiError(409, 'conflict', `The invoice is ${current?.status ?? 'gone'} and cannot be cancelled`);
	}
	return updated;
}
