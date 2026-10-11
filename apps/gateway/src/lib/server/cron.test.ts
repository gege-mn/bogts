import { describe, expect, it } from 'vitest';
import { heartbeat, jobsFor } from './cron';
import { cronHeartbeat } from './schema';
import { createTestDb } from './testdb';

const at = (minute: number) => Date.UTC(2026, 8, 25, 12, minute, 0);

describe('jobsFor', () => {
	it('delivers every minute', () => {
		expect(jobsFor(at(7)).map((j) => j.name)).toEqual(['deliver', 'notify']);
	});
	it('sweeps, then late-checks, when minute % 10 === 0', () => {
		expect(jobsFor(at(10)).map((j) => j.name)).toEqual(['deliver', 'sweep', 'late_check', 'notify']);
		expect(jobsFor(at(50)).map((j) => j.name)).toEqual(['deliver', 'sweep', 'late_check', 'notify']);
	});
	it('reconciles renewals once an hour, at minute 5', () => {
		expect(jobsFor(at(5)).map((j) => j.name)).toEqual(['deliver', 'reconcile', 'notify']);
		expect(jobsFor(at(15)).map((j) => j.name)).toEqual(['deliver', 'notify']);
	});
	it('purges at the top of the hour', () => {
		expect(jobsFor(at(0)).map((j) => j.name)).toEqual(['deliver', 'sweep', 'late_check', 'notify', 'purge']);
	});
});

describe('heartbeat', () => {
	it('upserts one row per job', async () => {
		const db = createTestDb();
		await heartbeat(db, 'deliver', 1000, null);
		await heartbeat(db, 'deliver', 2000, 'TypeError');
		const rows = await db.select().from(cronHeartbeat);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: 'deliver', lastRunAt: 2000, lastError: 'TypeError' });
	});
});
