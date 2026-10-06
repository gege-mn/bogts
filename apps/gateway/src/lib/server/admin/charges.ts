/** Dashboard reads for saved-card charges. */
import { asc, count, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import { batchSelect, type DB } from '../db';
import { CHARGE_STATUSES, card, charge, project, type ChargeStatus } from '../schema';
import { all, finishPage, PAGE_SIZE, scoped, subjectEventsFrom, subjectEventsStatements, type Cursor, type Page } from './common';
import { timelineFrom, timelineStatements, type TimelineEntry } from './timeline';

export const CHARGE_TILES = ['succeeded', 'pending', 'failed', 'reversed'] as const;

export type ChargeFilter = { projectId: string | null; status?: ChargeStatus | null };

export function chargeFilterFrom(url: URL, projectId: string | null): ChargeFilter {
	const s = url.searchParams.get('status');
	return { projectId, status: (CHARGE_STATUSES as readonly string[]).includes(s ?? '') ? (s as ChargeStatus) : null };
}

/** "Processing" covers both pending and queued. */
const statusCond = (s: ChargeStatus | null | undefined) =>
	!s ? undefined : s === 'pending' || s === 'queued' ? inArray(charge.status, ['pending', 'queued']) : eq(charge.status, s);

function listChargesQuery(db: DB, f: ChargeFilter, cursor: Cursor) {
	return db
		.select(
			batchSelect({
				id: charge.id,
				projectId: charge.projectId,
				projectName: project.name,
				amount: charge.amount,
				status: charge.status,
				reference: charge.reference,
				subscriptionId: charge.subscriptionId,
				cardMask: card.mask,
				createdAt: charge.createdAt
			})
		)
		.from(charge)
		.innerJoin(project, eq(project.id, charge.projectId))
		.innerJoin(card, eq(card.id, charge.cardId))
		.where(
			all(
				scoped(charge.projectId, f.projectId),
				statusCond(f.status),
				cursor.before ? lt(charge.id, cursor.before) : undefined,
				cursor.after ? gt(charge.id, cursor.after) : undefined
			)
		)
		.orderBy(cursor.after ? asc(charge.id) : desc(charge.id))
		.limit(PAGE_SIZE + 1);
}

export async function listCharges(db: DB, f: ChargeFilter, cursor: Cursor = {}) {
	return finishPage(await listChargesQuery(db, f, cursor), cursor);
}
export type ChargeRow = Awaited<ReturnType<typeof listCharges>> extends Page<infer R> ? R : never;

function chargeCountsQuery(db: DB, f: ChargeFilter) {
	return db.select(batchSelect({ status: charge.status, n: count() })).from(charge).where(scoped(charge.projectId, f.projectId)).groupBy(charge.status);
}

export async function chargeCounts(db: DB, f: ChargeFilter): Promise<Record<string, number>> {
	return chargeCountsFrom(await chargeCountsQuery(db, f));
}

/** The charges list and its tiles in one round trip. */
export async function chargesPage(db: DB, f: ChargeFilter, cursor: Cursor = {}) {
	const [rows, counts] = await db.batch([listChargesQuery(db, f, cursor), chargeCountsQuery(db, f)]);
	return { page: finishPage(rows, cursor), counts: chargeCountsFrom(counts) };
}

function chargeCountsFrom(rows: { status: ChargeStatus; n: number }[]): Record<string, number> {
	const out: Record<string, number> = { all: 0 };
	for (const r of rows) {
		const key = r.status === 'queued' ? 'pending' : r.status;
		out[key] = (out[key] ?? 0) + r.n;
		out.all = (out.all ?? 0) + r.n;
	}
	return out;
}

/** The charge page in one round trip: everything after the charge row is read by its id. */
export async function getChargeDetail(db: DB, id: string) {
	const [[row], eventRows, deliveryRows, ...timelineRows] = await db.batch([
		db
			.select(batchSelect({ charge, card, project: { id: project.id, name: project.name } }))
			.from(charge)
			.innerJoin(card, eq(card.id, charge.cardId))
			.innerJoin(project, eq(project.id, charge.projectId))
			.where(eq(charge.id, id))
			.limit(1),
		...subjectEventsStatements(db, [id]),
		...timelineStatements(db, 'charge', [id])
	]);
	if (!row) return null;
	const c = row.charge;
	const events = subjectEventsFrom([eventRows, deliveryRows]);
	const extra: TimelineEntry[] = [
		{ key: 'created', at: c.createdAt, source: 'gateway', title: 'Charge requested', detail: `transaction ${c.providerTransactionId}`, href: null }
	];
	if (c.status === 'queued') {
		extra.push({ key: 'queued', at: c.updatedAt, source: 'provider', title: 'Queued by Bonum', detail: 'waiting for TOKEN-PAYMENT', href: null });
	}
	const timeline = timelineFrom(timelineRows, { subjectType: 'charge', events, extra });
	return {
		charge: {
			id: c.id,
			amount: c.amount,
			items: c.items,
			status: c.status,
			reference: c.reference,
			subscriptionId: c.subscriptionId,
			providerTransactionId: c.providerTransactionId,
			failureCode: c.failureCode,
			reversedAt: c.reversedAt,
			createdAt: c.createdAt,
			updatedAt: c.updatedAt
		},
		card: { id: row.card.id, mask: row.card.mask, expiry: row.card.expiry, bankName: row.card.bankName, customerRef: row.card.customerRef },
		project: row.project,
		events,
		timeline
	};
}
