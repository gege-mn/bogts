/**
 * The scheduled tick (`triggers.crons = ["* * * * *"]`), called from
 * `src/worker.ts`. Every minute: retry due webhook deliveries. When the
 * minute is a multiple of 10: the invoice expiry sweep with the expiry of
 * abandoned card steps, then the late check of expired QPay invoices. At
 * minute 5: renewal reconciliation (`reconcile.ts`). At minute 0: purge
 * expired idempotency keys and old rate-limit windows. Each job, and the tick
 * as a whole (`tick`), writes a `cron_heartbeat` row.
 *
 * Imported by relative path from the Worker entry, which wrangler bundles with
 * esbuild (no `$lib`), so nothing reachable from here may import `$lib` or
 * `$app/*`.
 */
import { getDb, type DB } from './db';
import { tryLoadConfig, type Config, type Env } from './env';
import { deliverDue } from './events/deliver';
import { purgeIdempotency } from './idempotency';
import { purgeRateLimits } from './rate-limit';
import { cronHeartbeat } from './schema';
import { reconcileRenewals } from './reconcile';
import { expireCardSteps } from './services/cards';
import { lateCheckExpired, sweepExpired } from './sweep';

/** The hourly renewal reconciliation runs at this minute (off the busy :00). */
export const RECONCILE_MINUTE = 5;

type Job = { name: string; run: (db: DB, config: Config, now: number) => Promise<unknown> };

/** Which jobs run at `scheduledTime` (epoch ms). */
export function jobsFor(scheduledTime: number): Job[] {
	const minute = new Date(scheduledTime).getUTCMinutes();
	const jobs: Job[] = [{ name: 'deliver', run: deliverDue }];
	if (minute % 10 === 0) {
		jobs.push({
			name: 'sweep',
			run: async (db, config, now) => {
				await sweepExpired(db, config, now);
				await expireCardSteps(db, config, now);
			}
		});
		jobs.push({ name: 'late_check', run: lateCheckExpired });
	}
	if (minute === RECONCILE_MINUTE) jobs.push({ name: 'reconcile', run: reconcileRenewals });
	if (minute === 0) {
		jobs.push({
			name: 'purge',
			run: async (db, _config, now) => {
				await purgeIdempotency(db, now);
				await purgeRateLimits(db, now);
			}
		});
	}
	return jobs;
}

/**
 * Runs the tick's jobs. Never rejects: each job's failure is logged (by error
 * name only) and does not stop the others. An unconfigured deployment does nothing.
 */
export async function runCron(env: Env, ctx: ExecutionContext, scheduledTime: number): Promise<void> {
	void ctx;
	const loaded = tryLoadConfig(env);
	if (!loaded.ok) {
		console.warn('[cron] skipped: not configured');
		return;
	}
	const db = getDb(env.DB);
	const tickStart = Date.now();
	let tickError: string | null = null;
	for (const job of jobsFor(scheduledTime)) {
		const start = Date.now();
		let error: string | null = null;
		try {
			await job.run(db, loaded.config, start);
		} catch (err) {
			error = err instanceof Error ? err.name : typeof err;
			tickError ??= `${job.name}: ${error}`;
			console.error(`[cron] ${job.name} failed`, error);
		}
		await heartbeat(db, job.name, start, error);
	}
	await heartbeat(db, 'tick', tickStart, tickError);
}

/** Upserts a `cron_heartbeat` row. A failure here is logged, never thrown. */
export async function heartbeat(db: DB, name: string, startedAt: number, error: string | null): Promise<void> {
	const row = { lastRunAt: startedAt, lastDurationMs: Date.now() - startedAt, lastError: error };
	try {
		await db
			.insert(cronHeartbeat)
			.values({ name, ...row })
			.onConflictDoUpdate({ target: cronHeartbeat.name, set: row });
	} catch (err) {
		console.error('[cron] heartbeat failed', err instanceof Error ? err.name : typeof err);
	}
}
