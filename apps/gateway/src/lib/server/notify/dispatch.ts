/**
 * Notifications to the operators' channels (Discord, Telegram, JSON webhook).
 *
 * Nothing in the payment path knows about this. The dispatcher looks at the
 * ledger, which holds every payment exactly once, and writes one
 * `notification` row per (channel, payment) that is not there yet; the unique
 * index on that pair is what makes a second look harmless. A channel gets a
 * payment when it is enabled, wants `payment.received`, is global or belongs
 * to the payment's project, and was active when the payment was recorded.
 * Only money in counts (`amount > 0`): a reversal is not a payment received.
 *
 *  - `notifyFresh(ctx)`: after a request that may have settled a payment
 *    (hooks.server.ts, via waitUntil). Looks back 2 minutes and sends what it
 *    found. One cheap read when there is nothing to do.
 *  - `notifyDue(db, config, now)`: the every-minute cron. Looks back an hour
 *    (so a payment the inline pass never saw is picked up) and sends everything
 *    due, retries included.
 *  - `purgeNotifications(db, now)`: the hourly purge.
 *
 * Claiming works as in `events/deliver.ts`: one conditional UPDATE increments
 * `attempts` and pushes `next_attempt_at` out by a lease, so two runs never
 * send the same row. Sending is at least once.
 *
 * Reachable from the cron, so no `$lib` imports.
 */
import { and, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { BatchItem, DB } from '../db';
import type { Config } from '../env';
import { CLAIM_LEASE_MS, type AttemptOutcome } from '../events/deliver';
import { newId } from '../ids';
import { ledger, notification, notifyChannel, type DeliveryStatus, type Notification, type NotifyChannel } from '../schema';
import { nowOf, type ServiceContext } from '../services/context';
import { channelConfig } from './channels';
import { paymentsReceived, type NotificationBody } from './message';
import { sendNotification } from './send';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Wait after the n-th failed attempt (index n-1). */
export const NOTIFY_RETRY_DELAYS_MS = [MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR] as const;
/** A notification is news: no attempt is scheduled later than this after it was written. */
export const NOTIFY_RETRY_WINDOW_MS = DAY;
/** How far back the inline pass looks for payments without a notification. */
export const NOTIFY_FRESH_WINDOW_MS = 2 * MINUTE;
/** How far back the cron looks. */
export const NOTIFY_CRON_WINDOW_MS = HOUR;
/** Rows are kept this long for the unique index to guard; far longer than either window. */
export const NOTIFY_RETENTION_MS = 30 * DAY;
export const NOTIFY_ENQUEUE_LIMIT = 200;
export const NOTIFY_BATCH_SIZE = 50;
export const NOTIFY_CONCURRENCY = 5;

/** When to try next after `attempts` failed attempts (1-based), or null to give up. */
export function nextNotifyAttempt(createdAt: number, attempts: number, now: number): number | null {
	const i = Math.max(1, attempts) - 1;
	const next = now + NOTIFY_RETRY_DELAYS_MS[Math.min(i, NOTIFY_RETRY_DELAYS_MS.length - 1)]!;
	return next > createdAt + NOTIFY_RETRY_WINDOW_MS ? null : next;
}

/* ------------------------------------------------------------------ *
 * Enqueueing
 * ------------------------------------------------------------------ */

/** Seven bound values per row, and D1 takes at most 100 per statement. */
const INSERT_CHUNK = 12;

/**
 * Writes the missing `payment.received` notifications for payments recorded
 * in the last `windowMs`, and returns the ids of the rows it wrote.
 */
async function enqueuePayments(db: DB, now: number, windowMs: number): Promise<string[]> {
	const missing = await db
		.select({ ledgerId: ledger.id, channelId: notifyChannel.id })
		.from(ledger)
		.innerJoin(
			notifyChannel,
			and(
				eq(notifyChannel.enabled, true),
				or(isNull(notifyChannel.projectId), eq(notifyChannel.projectId, ledger.projectId)),
				lte(notifyChannel.activeFrom, ledger.createdAt),
				sql`exists (select 1 from json_each(${notifyChannel.types}) where value = 'payment.received')`
			)
		)
		.where(
			and(
				gte(ledger.createdAt, now - windowMs),
				gt(ledger.amount, 0),
				sql`not exists (select 1 from ${notification} where ${notification.channelId} = ${notifyChannel.id} and ${notification.type} = 'payment.received' and ${notification.sourceId} = ${ledger.id})`
			)
		)
		.orderBy(ledger.createdAt)
		.limit(NOTIFY_ENQUEUE_LIMIT);
	if (missing.length === 0) return [];

	const rows = missing.map((m) => ({
		id: newId(),
		channelId: m.channelId,
		type: 'payment.received' as const,
		sourceId: m.ledgerId,
		nextAttemptAt: now,
		createdAt: now,
		updatedAt: now
	}));
	const inserts: BatchItem[] = [];
	for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
		// Another run may have written the same pair meanwhile: the unique index drops it here.
		inserts.push(db.insert(notification).values(rows.slice(i, i + INSERT_CHUNK)).onConflictDoNothing().returning({ id: notification.id }));
	}
	const written = (await db.batch(inserts as [BatchItem, ...BatchItem[]])) as { id: string }[][];
	return written.flat().map((r) => r.id);
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

const claimSet = (now: number) => ({
	attempts: sql`${notification.attempts} + 1`,
	nextAttemptAt: now + CLAIM_LEASE_MS,
	updatedAt: now
});

const due = (now: number) => and(eq(notification.status, 'pending'), lte(notification.nextAttemptAt, now));

/** Settles a claimed notification without a request (its channel is paused or its payment is gone). */
async function settleUnsent(db: DB, n: Notification, reason: string, now: number): Promise<void> {
	await db
		.update(notification)
		.set({ status: 'failed', nextAttemptAt: null, lastError: reason, attempts: sql`${notification.attempts} - 1`, updatedAt: now })
		.where(and(eq(notification.id, n.id), eq(notification.attempts, n.attempts)));
}

async function recordOutcome(db: DB, n: Notification, outcome: AttemptOutcome, now: number): Promise<void> {
	const next = outcome.ok ? null : nextNotifyAttempt(n.createdAt, n.attempts, now);
	const status: DeliveryStatus = outcome.ok ? 'succeeded' : next === null ? 'failed' : 'pending';
	await db.batch([
		db
			.update(notification)
			.set({
				status,
				nextAttemptAt: next,
				lastStatus: outcome.httpStatus,
				lastError: outcome.error,
				...(outcome.ok ? { sentAt: now } : {}),
				updatedAt: now
			})
			// Only if nobody claimed it again meanwhile (lease expiry).
			.where(and(eq(notification.id, n.id), eq(notification.attempts, n.attempts))),
		db
			.update(notifyChannel)
			.set(outcome.ok ? { lastSentAt: now, lastError: null, lastErrorAt: null } : { lastError: outcome.error, lastErrorAt: now })
			.where(eq(notifyChannel.id, n.channelId))
	]);
}

/** Sends one claimed notification and records it. Never throws. */
async function sendClaimed(
	db: DB,
	config: Config,
	n: Notification,
	channel: NotifyChannel | undefined,
	body: NotificationBody | undefined,
	now: number
): Promise<void> {
	try {
		if (!channel || !channel.enabled) return await settleUnsent(db, n, 'channel_paused', now);
		if (!body) return await settleUnsent(db, n, 'source_missing', now);
		let outcome: AttemptOutcome;
		try {
			outcome = await sendNotification(await channelConfig(channel, config.encryptionKey), body);
		} catch {
			outcome = { ok: false, httpStatus: null, error: 'config_unavailable', responseBody: null, durationMs: 0 };
		}
		await recordOutcome(db, n, outcome, now);
	} catch (err) {
		console.error('[notify] attempt failed', err instanceof Error ? err.name : typeof err, n.id);
	}
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await fn(items[next++]!);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Loads the channels and payments of claimed notifications and sends each. */
async function sendAll(db: DB, config: Config, claimed: Notification[], now: number): Promise<number> {
	if (claimed.length === 0) return 0;
	const channelIds = [...new Set(claimed.map((n) => n.channelId))];
	const [channels, payments] = await Promise.all([
		db.select().from(notifyChannel).where(inArray(notifyChannel.id, channelIds)),
		paymentsReceived(
			db,
			config,
			claimed.map((n) => n.sourceId)
		)
	]);
	const channelById = new Map(channels.map((c) => [c.id, c]));
	await pool(claimed, NOTIFY_CONCURRENCY, (n) => {
		const payment = payments.get(n.sourceId);
		const body: NotificationBody | undefined = payment && {
			id: n.id,
			object: 'notification',
			type: n.type,
			createdAt: new Date(payment.createdAt).toISOString(),
			origin: config.publicOrigin,
			project: payment.project,
			data: payment.data
		};
		return sendClaimed(db, config, n, channelById.get(n.channelId), body, now);
	});
	return claimed.length;
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

/**
 * The inline pass: notifications for payments recorded in the last 2 minutes,
 * sent now. Returns how many it sent. Never rejects.
 */
export async function notifyFresh(ctx: ServiceContext): Promise<number> {
	const { db, config } = ctx;
	const now = nowOf(ctx);
	try {
		const ids = await enqueuePayments(db, now, NOTIFY_FRESH_WINDOW_MS);
		if (ids.length === 0) return 0;
		const claimed = await db
			.update(notification)
			.set(claimSet(now))
			.where(and(inArray(notification.id, ids.slice(0, NOTIFY_BATCH_SIZE)), due(now)))
			.returning();
		return await sendAll(db, config, claimed, now);
	} catch (err) {
		console.error('[notify] notifyFresh failed', err instanceof Error ? err.name : typeof err);
		return 0;
	}
}

/**
 * The cron: writes the notifications still missing for the last hour's
 * payments, then sends up to 50 that are due, 5 at a time. Returns how many it
 * sent. Never rejects.
 */
export async function notifyDue(db: DB, config: Config, now: number): Promise<number> {
	try {
		await enqueuePayments(db, now, NOTIFY_CRON_WINDOW_MS);
		const candidates = await db
			.select({ id: notification.id })
			.from(notification)
			.where(due(now))
			.orderBy(notification.nextAttemptAt)
			.limit(NOTIFY_BATCH_SIZE);
		if (candidates.length === 0) return 0;
		const claimed = await db
			.update(notification)
			.set(claimSet(now))
			.where(
				and(
					inArray(
						notification.id,
						candidates.map((c) => c.id)
					),
					due(now)
				)
			)
			.returning();
		return await sendAll(db, config, claimed, now);
	} catch (err) {
		console.error('[notify] notifyDue failed', err instanceof Error ? err.name : typeof err);
		return 0;
	}
}

/** Drops notifications older than 30 days; run from the cron. */
export async function purgeNotifications(db: DB, now: number): Promise<void> {
	await db.delete(notification).where(lt(notification.createdAt, now - NOTIFY_RETENTION_MS));
}
