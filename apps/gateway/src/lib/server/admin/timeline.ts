/**
 * The per-subject timeline on payment, subscription and charge pages
 * (ux-brief §7.3): it merges the ledger (payments the provider proved), the
 * activity log (webhooks, checks, failures), our emitted events with their
 * delivery, and dashboard actions from the audit log. Summaries only: no
 * provider bodies are stored, so none are shown.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db';
import { activity, auditLog, ledger, type Activity, type ActivitySubjectType, type AuditLog, type Ledger } from '../schema';
import { formatMoney } from '$lib/format';
import { providerName } from '$lib/status';
import type { DeliverySummary, SubjectEvent } from './common';

export type TimelineSource = 'gateway' | 'provider' | 'event' | 'admin';

export type TimelineEntry = {
	key: string;
	at: number;
	source: TimelineSource;
	title: string;
	detail: string | null;
	href: string | null;
	/** Set on emitted events */
	eventType?: string;
	delivery?: DeliverySummary | null;
};

const AUDIT_TITLES: Record<string, string> = {
	'subscription.cancel': 'Cancelled from the dashboard',
	'charge.reverse': 'Reversal requested from the dashboard',
	'charge.create': 'Charged from the dashboard',
	'card.create': 'Card step started from the dashboard',
	'card.remove': 'Removed from the dashboard',
	'invoice.cancel': 'Cancelled from the dashboard'
};

type TimelineInput = {
	subjectType: ActivitySubjectType;
	subjectIds: string[];
	events: SubjectEvent[];
	extra?: TimelineEntry[];
};

/** The timeline's three reads (ledger, activity, audit log), for a caller's `db.batch`. `ids` must not be empty. */
export function timelineStatements(db: DB, subjectType: ActivitySubjectType, ids: string[]) {
	return [
		db.select().from(ledger).where(inArray(ledger.subjectId, ids)).orderBy(desc(ledger.createdAt)).limit(200),
		db
			.select()
			.from(activity)
			.where(and(eq(activity.subjectType, subjectType), inArray(activity.subjectId, ids)))
			.orderBy(desc(activity.createdAt))
			.limit(200),
		db.select().from(auditLog).where(inArray(auditLog.subject, ids)).orderBy(desc(auditLog.createdAt)).limit(100)
	] as const;
}

type TimelineRows = readonly [Ledger[], Activity[], AuditLog[]];

/** Everything recorded about the subject(s), newest first. `extra` adds synthesized entries (created, swept, …). */
export async function buildTimeline(db: DB, input: TimelineInput): Promise<TimelineEntry[]> {
	const rows: TimelineRows = input.subjectIds.length
		? await db.batch(timelineStatements(db, input.subjectType, input.subjectIds))
		: [[], [], []];
	return timelineFrom(rows, input);
}

/** `buildTimeline` from already-read `timelineStatements` rows. */
export function timelineFrom([ledgerRows, activityRows, auditRows]: TimelineRows, input: Omit<TimelineInput, 'subjectIds'>): TimelineEntry[] {
	const entries: TimelineEntry[] = [...(input.extra ?? [])];
	for (const l of ledgerRows) {
		entries.push({
			key: `l:${l.id}`,
			at: l.createdAt,
			source: 'provider',
			title: l.amount < 0 ? `Reversal recorded · ${formatMoney(l.amount)}` : `Payment received · ${formatMoney(l.amount)}`,
			detail: `from ${providerName(l.provider)} · ref ${l.providerRef}`,
			href: null
		});
	}
	for (const a of activityRows) {
		entries.push({
			key: `a:${a.id}`,
			at: a.createdAt,
			source: a.source,
			title: a.summary,
			detail: a.source === 'provider' ? a.kind : null,
			href: null
		});
	}
	for (const a of auditRows) {
		entries.push({
			key: `u:${a.id}`,
			at: a.createdAt,
			source: 'admin',
			title: AUDIT_TITLES[a.action] ?? a.action,
			detail: a.actor === 'password' ? 'by admin' : `by ${a.actor.replace(/^access:/, '')}`,
			href: null
		});
	}
	for (const e of input.events) {
		entries.push({
			key: `e:${e.id}`,
			at: e.createdAt,
			source: 'event',
			title: e.type,
			detail: null,
			href: `/admin/events/${e.id}`,
			eventType: e.type,
			delivery: e.delivery
		});
	}
	return entries.sort((a, b) => b.at - a.at || b.key.localeCompare(a.key));
}
