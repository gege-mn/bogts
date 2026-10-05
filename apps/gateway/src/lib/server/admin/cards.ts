/**
 * Dashboard reads for saved cards. A card that is `pending` or `failed` is a
 * `card_setup` row (the card step); `active` and `removed` are `card` rows
 * under the same id.
 */
import { asc, count, desc, eq, gt, inArray, lt, ne } from 'drizzle-orm';
import { batchSelect, type DB } from '../db';
import { card, cardSetup, charge, project, subscription, type CardSetupStatus, type CardStatus } from '../schema';
import { all, finishPage, PAGE_SIZE, scoped, subjectEventsFrom, subjectEventsStatements, type Cursor, type Page } from './common';
import { timelineFrom, timelineStatements, type TimelineEntry } from './timeline';

export const CARD_VIEW_STATUSES = ['active', 'pending', 'failed', 'removed'] as const;
export type CardViewStatus = (typeof CARD_VIEW_STATUSES)[number];

export type CardFilter = { projectId: string | null; status?: CardViewStatus | null };

export function cardFilterFrom(url: URL, projectId: string | null): CardFilter {
	const s = url.searchParams.get('status');
	return { projectId, status: (CARD_VIEW_STATUSES as readonly string[]).includes(s ?? '') ? (s as CardViewStatus) : null };
}

export type CardRow = {
	id: string;
	projectId: string;
	projectName: string;
	customerRef: string;
	status: CardViewStatus;
	mask: string | null;
	bankName: string | null;
	expiry: string | null;
	createdAt: number;
};

function listSavedQuery(db: DB, f: CardFilter, status: CardStatus | null, cursor: Cursor) {
	return db
		.select(
			batchSelect({
				id: card.id,
				projectId: card.projectId,
				projectName: project.name,
				customerRef: card.customerRef,
				status: card.status,
				mask: card.mask,
				bankName: card.bankName,
				expiry: card.expiry,
				createdAt: card.createdAt
			})
		)
		.from(card)
		.innerJoin(project, eq(project.id, card.projectId))
		.where(
			all(
				scoped(card.projectId, f.projectId),
				status ? eq(card.status, status) : undefined,
				cursor.before ? lt(card.id, cursor.before) : undefined,
				cursor.after ? gt(card.id, cursor.after) : undefined
			)
		)
		.orderBy(cursor.after ? asc(card.id) : desc(card.id))
		.limit(PAGE_SIZE + 1);
}

function listSetupsQuery(db: DB, f: CardFilter, status: CardSetupStatus, cursor: Cursor) {
	return db
		.select(
			batchSelect({
				id: cardSetup.id,
				projectId: cardSetup.projectId,
				projectName: project.name,
				customerRef: cardSetup.customerRef,
				status: cardSetup.status,
				createdAt: cardSetup.createdAt
			})
		)
		.from(cardSetup)
		.innerJoin(project, eq(project.id, cardSetup.projectId))
		.where(
			all(
				scoped(cardSetup.projectId, f.projectId),
				eq(cardSetup.status, status),
				cursor.before ? lt(cardSetup.id, cursor.before) : undefined,
				cursor.after ? gt(cardSetup.id, cursor.after) : undefined
			)
		)
		.orderBy(cursor.after ? asc(cardSetup.id) : desc(cardSetup.id))
		.limit(PAGE_SIZE + 1);
}

function cardCountsQuery(db: DB, f: CardFilter) {
	return db.select(batchSelect({ status: card.status, n: count() })).from(card).where(scoped(card.projectId, f.projectId)).groupBy(card.status);
}

function setupCountsQuery(db: DB, f: CardFilter) {
	return db
		.select(batchSelect({ status: cardSetup.status, n: count() }))
		.from(cardSetup)
		.where(all(scoped(cardSetup.projectId, f.projectId), ne(cardSetup.status, 'completed')))
		.groupBy(cardSetup.status);
}

/**
 * The cards list and its tiles in one round trip. "All" is the saved cards
 * (active and removed); card steps show under "Awaiting card" and "Failed".
 */
export async function cardsPage(db: DB, f: CardFilter, cursor: Cursor = {}): Promise<{ page: Page<CardRow>; counts: Record<string, number> }> {
	const counts = [cardCountsQuery(db, f), setupCountsQuery(db, f)] as const;
	let rows: CardRow[];
	let saved: { status: string; n: number }[];
	let steps: { status: string; n: number }[];
	if (f.status === 'pending' || f.status === 'failed') {
		const [list, c, s] = await db.batch([listSetupsQuery(db, f, f.status, cursor), ...counts]);
		rows = list.map((r) => ({ ...r, status: f.status as CardViewStatus, mask: null, bankName: null, expiry: null }));
		[saved, steps] = [c, s];
	} else {
		const [list, c, s] = await db.batch([listSavedQuery(db, f, f.status ?? null, cursor), ...counts]);
		rows = list;
		[saved, steps] = [c, s];
	}
	const out: Record<string, number> = { all: 0 };
	for (const r of saved) {
		out[r.status] = r.n;
		out.all = (out.all ?? 0) + r.n;
	}
	for (const r of steps) out[r.status] = r.n;
	return { page: finishPage(rows, cursor), counts: out };
}

/** The card page in one round trip: the card, its card step, what bills it and what was charged to it. */
export async function getCardDetail(db: DB, id: string) {
	const [[saved], [step], charges, subscriptions, eventRows, deliveryRows, ...timelineRows] = await db.batch([
		db
			.select(batchSelect({ card, project: { id: project.id, name: project.name } }))
			.from(card)
			.innerJoin(project, eq(project.id, card.projectId))
			.where(eq(card.id, id))
			.limit(1),
		db
			.select(batchSelect({ setup: cardSetup, project: { id: project.id, name: project.name } }))
			.from(cardSetup)
			.innerJoin(project, eq(project.id, cardSetup.projectId))
			.where(eq(cardSetup.id, id))
			.limit(1),
		db
			.select({ id: charge.id, amount: charge.amount, status: charge.status, reference: charge.reference, createdAt: charge.createdAt })
			.from(charge)
			.where(eq(charge.cardId, id))
			.orderBy(desc(charge.id))
			.limit(50),
		// Live Bonum-plan subscriptions on this card: Bonum bills it, so it can't be removed here.
		db
			.select({ id: subscription.id, status: subscription.status })
			.from(subscription)
			.where(all(eq(subscription.cardId, id), inArray(subscription.status, ['pending', 'active', 'past_due'])))
			.limit(5),
		...subjectEventsStatements(db, [id]),
		...timelineStatements(db, 'card', [id])
	]);
	const c = saved?.card ?? null;
	const s = step?.setup ?? null;
	const owner = saved?.project ?? step?.project;
	if (!owner || (!c && !s)) return null;

	const events = subjectEventsFrom([eventRows, deliveryRows]);
	const extra: TimelineEntry[] = [];
	if (s) {
		extra.push({
			key: 'created',
			at: s.createdAt,
			source: 'gateway',
			title: s.replacesCardId ? 'Card replacement started' : 'Card step started',
			detail: s.paymentAmount ? `with a first payment of ${s.paymentAmount} MNT` : 'no first payment',
			href: null
		});
	} else if (c) {
		extra.push({ key: 'created', at: c.createdAt, source: 'gateway', title: 'Card saved', detail: 'with a subscription', href: null });
	}
	const status: CardViewStatus = c ? c.status : s!.status === 'failed' ? 'failed' : 'pending';
	return {
		card: {
			id,
			customerRef: (c ?? s!).customerRef,
			status,
			mask: c?.mask ?? null,
			expiry: c?.expiry ?? null,
			bankName: c?.bankName ?? null,
			removedAt: c?.removedAt ?? null,
			createdAt: (s ?? c!).createdAt,
			savedAt: c?.createdAt ?? null,
			/** Bonum's card page, while the customer has not finished */
			cardPageUrl: status === 'pending' ? (s?.followUpLink ?? null) : null,
			replacesCardId: s?.replacesCardId ?? null,
			firstPayment: s?.paymentAmount ? { amount: s.paymentAmount, reference: s.paymentReference, items: s.paymentItems } : null
		},
		project: owner,
		charges,
		subscriptions,
		events,
		timeline: timelineFrom(timelineRows, { subjectType: 'card', events, extra })
	};
}
