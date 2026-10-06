/**
 * Global search: an exact id jumps to its page; otherwise an exact
 * `reference` or `customerRef` lists the matches by type.
 */
import { eq, desc } from 'drizzle-orm';
import type { DB } from '../db';
import { card, cardSetup, charge, event, invoice, project, subscription } from '../schema';
import { isId } from './common';

/** The detail page of an exact id, or null. */
export async function findById(db: DB, raw: string): Promise<string | null> {
	const id = raw.trim().toUpperCase();
	if (!isId(id)) return null;
	// Seven primary-key probes in one round trip; the first hit, in this order, wins.
	const prefixes = ['/admin/payments/', '/admin/subscriptions/', '/admin/charges/', '/admin/events/', '/admin/projects/', '/admin/cards/', '/admin/cards/'];
	const hits = await db.batch([
		db.select({ id: invoice.id }).from(invoice).where(eq(invoice.id, id)).limit(1),
		db.select({ id: subscription.id }).from(subscription).where(eq(subscription.id, id)).limit(1),
		db.select({ id: charge.id }).from(charge).where(eq(charge.id, id)).limit(1),
		db.select({ id: event.id }).from(event).where(eq(event.id, id)).limit(1),
		db.select({ id: project.id }).from(project).where(eq(project.id, id)).limit(1),
		db.select({ id: card.id }).from(card).where(eq(card.id, id)).limit(1),
		db.select({ id: cardSetup.id }).from(cardSetup).where(eq(cardSetup.id, id)).limit(1)
	]);
	const i = hits.findIndex((rows) => rows.length > 0);
	return i < 0 ? null : prefixes[i]! + id;
}

/** Exact matches on `reference` (invoices, charges) and `customerRef` (subscriptions, cards). */
export async function searchRefs(db: DB, raw: string) {
	const q = raw.trim();
	if (!q) return { invoices: [], charges: [], subscriptions: [], cards: [] };
	// One round trip; each is an exact match on a column that leads an index (cards: a scan of a small table).
	const [invoices, charges, subscriptions, cards] = await db.batch([
		db
			.select({ id: invoice.id, amount: invoice.amount, status: invoice.status, reference: invoice.reference, createdAt: invoice.createdAt })
			.from(invoice)
			.where(eq(invoice.reference, q))
			.orderBy(desc(invoice.id))
			.limit(20),
		db
			.select({ id: charge.id, amount: charge.amount, status: charge.status, reference: charge.reference, createdAt: charge.createdAt })
			.from(charge)
			.where(eq(charge.reference, q))
			.orderBy(desc(charge.id))
			.limit(20),
		db
			.select({ id: subscription.id, status: subscription.status, customerRef: subscription.customerRef, createdAt: subscription.createdAt })
			.from(subscription)
			.where(eq(subscription.customerRef, q))
			.orderBy(desc(subscription.id))
			.limit(20),
		db
			.select({ id: card.id, status: card.status, customerRef: card.customerRef, mask: card.mask, createdAt: card.createdAt })
			.from(card)
			.where(eq(card.customerRef, q))
			.orderBy(desc(card.id))
			.limit(20)
	]);
	return { invoices, charges, subscriptions, cards };
}
