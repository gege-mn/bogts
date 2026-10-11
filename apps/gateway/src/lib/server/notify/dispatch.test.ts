import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChannel, parseChannelInput, setChannelEnabled } from '../admin/notify';
import { hmacSha256Hex } from '../crypto';
import { newId } from '../ids';
import { card, charge, invoice, ledger, notification, notifyChannel, subscription, type Invoice } from '../schema';
import { settleInvoice } from '../services/settle';
import { createTestDb, seedPlan, seedProject, testConfig, TEST_ENCRYPTION_KEY, type TestDb } from '../testdb';
import { nextNotifyAttempt, notifyDue, notifyFresh, NOTIFY_RETENTION_MS, NOTIFY_RETRY_WINDOW_MS, purgeNotifications } from './dispatch';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const config = testConfig();

const DISCORD_URL = 'https://discord.com/api/webhooks/123456789012345678/abc-DEF_token';
const TELEGRAM_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';

type Sent = { url: string; headers: Headers; body: string };

function stubFetch(respond: (req: Sent) => Response | Promise<Response> = () => new Response('ok')) {
	const sent: Sent[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = { url: String(input), headers: new Headers(init?.headers), body: String(init?.body) };
			sent.push(req);
			return respond(req);
		})
	);
	return sent;
}

afterEach(() => vi.unstubAllGlobals());

function form(fields: Record<string, string>, types = ['payment.received']) {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	for (const t of types) f.append('types', t);
	return f;
}

const addChannel = (db: TestDb, projectId: string | null, fields: Record<string, string>, at = NOW - HOUR) =>
	createChannel(db, TEST_ENCRYPTION_KEY, projectId, parseChannelInput(form(fields), false), at);
const addDiscord = (db: TestDb, projectId: string | null, at?: number) => addChannel(db, projectId, { kind: 'discord', url: DISCORD_URL }, at);

async function seedInvoice(db: TestDb, projectId: string, over: Partial<typeof invoice.$inferInsert> = {}): Promise<Invoice> {
	const [row] = await db
		.insert(invoice)
		.values({
			id: newId(),
			projectId,
			provider: 'qpay',
			amount: 49_000,
			reference: 'order_42',
			description: 'Pro plan',
			expiresAt: NOW + 30 * MIN,
			createdAt: NOW - MIN,
			updatedAt: NOW - MIN,
			...over
		})
		.returning();
	return row!;
}

/** An invoice paid through the real settle path at `at`. */
async function pay(db: TestDb, projectId: string, at = NOW, over: Partial<typeof invoice.$inferInsert> = {}) {
	const inv = await seedInvoice(db, projectId, over);
	expect(await settleInvoice({ db, config, now: at }, inv, { providerRef: `pay-${inv.id}`, amount: inv.amount })).toBe('settled');
	return inv;
}

/** No project webhook, so the only requests in a test are notifications. */
const seed = (db: TestDb, opts: Parameters<typeof seedProject>[1] = {}) => seedProject(db, { webhookUrl: null, ...opts });

const rowsOf = (db: TestDb) => db.select().from(notification).orderBy(notification.id);
const channelOf = async (db: TestDb, id: string) => (await db.select().from(notifyChannel).where(eq(notifyChannel.id, id)))[0]!;

describe('nextNotifyAttempt', () => {
	it('backs off and gives up a day after the notification was written', () => {
		expect(nextNotifyAttempt(NOW, 1, NOW)).toBe(NOW + MIN);
		expect(nextNotifyAttempt(NOW, 2, NOW)).toBe(NOW + 5 * MIN);
		expect(nextNotifyAttempt(NOW, 9, NOW)).toBe(NOW + 6 * HOUR);
		expect(nextNotifyAttempt(NOW, 5, NOW + NOTIFY_RETRY_WINDOW_MS - HOUR)).toBeNull();
	});
});

describe('which channels hear about a payment', () => {
	it('the project’s channels and the global ones, each once', async () => {
		const db = createTestDb();
		const a = await seed(db, { name: 'Sarvuu', now: NOW });
		const b = await seed(db, { name: 'Other', now: NOW });
		const own = await addDiscord(db, a.project.id);
		const global = await addDiscord(db, null);
		await addDiscord(db, b.project.id);
		const sent = stubFetch();
		await pay(db, a.project.id);

		expect(await notifyFresh({ db, config, now: NOW })).toBe(2);
		expect(sent).toHaveLength(2);
		expect((await rowsOf(db)).map((r) => [r.channelId, r.status, r.attempts]).sort()).toEqual(
			[
				[own.channel.id, 'succeeded', 1],
				[global.channel.id, 'succeeded', 1]
			].sort()
		);
		// Looking again, inline or from the cron, sends nothing more.
		expect(await notifyFresh({ db, config, now: NOW + 1000 })).toBe(0);
		expect(await notifyDue(db, config, NOW + MIN)).toBe(0);
		expect(sent).toHaveLength(2);
		expect((await channelOf(db, own.channel.id)).lastSentAt).toBe(NOW);
	});

	it('nothing is written or sent without a channel', async () => {
		const db = createTestDb();
		const { project } = await seed(db, { now: NOW });
		const sent = stubFetch();
		await pay(db, project.id);
		expect(await notifyFresh({ db, config, now: NOW })).toBe(0);
		expect(await notifyDue(db, config, NOW)).toBe(0);
		expect(await rowsOf(db)).toHaveLength(0);
		expect(sent).toHaveLength(0);
	});

	it('a channel only hears about payments recorded while it was active', async () => {
		const db = createTestDb();
		const { project } = await seed(db, { now: NOW });
		await pay(db, project.id, NOW - 10 * MIN);
		const { channel } = await addDiscord(db, project.id, NOW - 5 * MIN);
		const sent = stubFetch();
		expect(await notifyDue(db, config, NOW)).toBe(0);

		// Paused: the payment made meanwhile is never sent, even after resuming.
		await setChannelEnabled(db, project.id, channel.id, false, NOW);
		await pay(db, project.id, NOW + MIN);
		expect(await notifyDue(db, config, NOW + 2 * MIN)).toBe(0);
		await setChannelEnabled(db, project.id, channel.id, true, NOW + 3 * MIN);
		expect(await notifyDue(db, config, NOW + 4 * MIN)).toBe(0);
		expect(sent).toHaveLength(0);

		await pay(db, project.id, NOW + 5 * MIN);
		expect(await notifyDue(db, config, NOW + 6 * MIN)).toBe(1);
		expect(sent).toHaveLength(1);
	});

	it('a reversal is not a payment received', async () => {
		const db = createTestDb();
		const { project } = await seed(db, { now: NOW });
		await addDiscord(db, project.id);
		const sent = stubFetch();
		await db.insert(ledger).values({ id: newId(), projectId: project.id, provider: 'bonum', providerRef: 'rev-1', kind: 'charge', subjectId: newId(), amount: -5000, createdAt: NOW });
		expect(await notifyDue(db, config, NOW)).toBe(0);
		expect(sent).toHaveLength(0);
	});

	it('the cron picks up a payment the inline pass never saw', async () => {
		const db = createTestDb();
		const { project } = await seed(db, { now: NOW });
		await addDiscord(db, project.id);
		const sent = stubFetch();
		await pay(db, project.id, NOW - 30 * MIN);
		expect(await notifyFresh({ db, config, now: NOW })).toBe(0);
		expect(await notifyDue(db, config, NOW)).toBe(1);
		expect(sent).toHaveLength(1);
	});
});

describe('what each kind of channel is sent', () => {
	it('Discord: one embed with the amount, the project and the reference, and no mentions', async () => {
		const db = createTestDb();
		const { project } = await seed(db, { name: 'Sarvuu', now: NOW });
		await addDiscord(db, project.id);
		const sent = stubFetch(() => new Response(null, { status: 204 }));
		const inv = await pay(db, project.id);
		await notifyFresh({ db, config, now: NOW });

		expect(sent[0]!.url).toBe(DISCORD_URL);
		const body = JSON.parse(sent[0]!.body);
		expect(body.allowed_mentions).toEqual({ parse: [] });
		const [embed] = body.embeds;
		// testConfig connects QPay in its sandbox, and the message says so.
		expect(embed.title).toBe('[Sandbox] ₮49,000 received');
		expect(embed.description).toBe('**Sarvuu** · Invoice · QPay');
		expect(embed.url).toBe(`https://payments.test/admin/payments/${inv.id}`);
		expect(embed.fields).toContainEqual({ name: 'Reference', value: 'order\\_42', inline: true });
		expect(embed.footer).toEqual({ text: 'payments.test' });
		expect(embed.timestamp).toBe(new Date(NOW).toISOString());
	});

	it('Telegram: sendMessage to the chat, HTML-escaped', async () => {
		const db = createTestDb();
		const { project } = await seed(db, { name: 'A <b> & co', now: NOW });
		await addChannel(db, project.id, { kind: 'telegram', botToken: TELEGRAM_TOKEN, chatId: '-1001234567890', threadId: '7' });
		const sent = stubFetch(() => Response.json({ ok: true }));
		await pay(db, project.id);
		await notifyFresh({ db, config: testConfig({ qpay: { ...config.qpay!, environment: 'production' } }), now: NOW });

		expect(sent[0]!.url).toBe(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`);
		const body = JSON.parse(sent[0]!.body);
		expect(body).toMatchObject({ chat_id: '-1001234567890', message_thread_id: 7, parse_mode: 'HTML' });
		expect(body.text).toContain('<b>₮49,000 received</b>');
		expect(body.text).toContain('A &lt;b&gt; &amp; co · Invoice · QPay');
		expect(body.text).toContain('Reference: order_42');
	});

	it('Webhook: the signed JSON body, with the same id on a retry', async () => {
		const db = createTestDb();
		const { project } = await seed(db, { name: 'Sarvuu', slug: 'sarvuu', now: NOW });
		const { channel, secret } = await addChannel(db, project.id, { kind: 'webhook', url: 'https://ops.test/hooks/money' });
		expect(secret).toMatch(/^bgwh_/);
		let fail = true;
		const sent = stubFetch(() => (fail ? new Response('down', { status: 503 }) : new Response('ok')));
		const inv = await pay(db, project.id);
		await notifyFresh({ db, config, now: NOW });

		const [row] = await rowsOf(db);
		expect(row).toMatchObject({ status: 'pending', attempts: 1, lastStatus: 503, lastError: 'http_5xx', nextAttemptAt: NOW + MIN });
		expect(await channelOf(db, channel.id)).toMatchObject({ lastError: 'http_5xx', lastErrorAt: NOW, lastSentAt: null });

		fail = false;
		expect(await notifyDue(db, config, NOW + MIN)).toBe(1);
		expect((await rowsOf(db))[0]).toMatchObject({ status: 'succeeded', attempts: 2, nextAttemptAt: null, sentAt: NOW + MIN });
		expect(await channelOf(db, channel.id)).toMatchObject({ lastError: null, lastSentAt: NOW + MIN });

		expect(sent).toHaveLength(2);
		const req = sent[1]!;
		expect(req.url).toBe('https://ops.test/hooks/money');
		const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers.get('bogts-signature') ?? '');
		expect(match).not.toBeNull();
		expect(await hmacSha256Hex(secret!, `${match![1]}.${req.body}`)).toBe(match![2]);
		expect(req.headers.get('bogts-notification-id')).toBe(row!.id);
		expect(req.headers.get('bogts-notification-type')).toBe('payment.received');
		expect(JSON.parse(req.body)).toEqual({
			id: row!.id,
			object: 'notification',
			type: 'payment.received',
			createdAt: new Date(NOW).toISOString(),
			origin: 'https://payments.test',
			project: { id: project.id, name: 'Sarvuu', slug: 'sarvuu' },
			data: {
				ledgerId: expect.any(String),
				kind: 'invoice',
				provider: 'qpay',
				amount: 49_000,
				currency: 'MNT',
				subjectId: inv.id,
				reference: 'order_42',
				description: 'Pro plan',
				sandbox: true,
				dashboardUrl: `https://payments.test/admin/payments/${inv.id}`
			}
		});
		expect(JSON.parse(sent[0]!.body).id).toBe(row!.id);
	});

	it('subscription payments and card charges name the customer and the plan', async () => {
		const db = createTestDb();
		const { project } = await seed(db, { now: NOW });
		await addChannel(db, project.id, { kind: 'webhook', url: 'https://ops.test/hooks/money' });
		const plan = await seedPlan(db, project.id, { now: NOW });
		const cardId = newId();
		await db.insert(card).values({ id: cardId, projectId: project.id, customerRef: 'user_7', mask: '5150 23** **** 4778', createdAt: NOW, updatedAt: NOW });
		const subId = newId();
		await db.insert(subscription).values({ id: subId, projectId: project.id, planId: plan.id, customerRef: 'user_7', status: 'active', tokenizeTransactionId: newId(), cardId, createdAt: NOW, updatedAt: NOW });
		const chargeId = newId();
		await db.insert(charge).values({ id: chargeId, projectId: project.id, cardId, amount: 5000, reference: 'topup-1', providerTransactionId: newId(), status: 'succeeded', createdAt: NOW, updatedAt: NOW });
		await db.insert(ledger).values([
			{ id: newId(), projectId: project.id, provider: 'bonum', providerRef: 'sub-invoice:1', kind: 'subscription', subjectId: subId, amount: plan.amount, createdAt: NOW },
			{ id: newId(), projectId: project.id, provider: 'bonum', providerRef: 'chg-1', kind: 'charge', subjectId: chargeId, amount: 5000, createdAt: NOW + 1 }
		]);
		const sent = stubFetch();
		expect(await notifyDue(db, config, NOW + 10)).toBe(2);
		const bodies = sent.map((s) => JSON.parse(s.body).data).sort((x, y) => x.kind.localeCompare(y.kind));
		expect(bodies[0]).toMatchObject({ kind: 'charge', amount: 5000, reference: 'topup-1', customerRef: 'user_7', dashboardUrl: `https://payments.test/admin/charges/${chargeId}` });
		expect(bodies[1]).toMatchObject({ kind: 'subscription', amount: plan.amount, customerRef: 'user_7', plan: 'pro-monthly', dashboardUrl: `https://payments.test/admin/subscriptions/${subId}` });
	});
});

describe('failures', () => {
	it('a failing channel never stops another, and gives up after a day', async () => {
		const db = createTestDb();
		const { project } = await seed(db, { now: NOW });
		const bad = await addChannel(db, project.id, { kind: 'webhook', url: 'https://down.test/hook' });
		const good = await addDiscord(db, project.id);
		const sent = stubFetch((req) => (req.url.startsWith('https://down.test') ? new Response('no', { status: 500 }) : new Response(null, { status: 204 })));
		await pay(db, project.id);
		await notifyFresh({ db, config, now: NOW });
		const byChannel = async () => new Map((await rowsOf(db)).map((r) => [r.channelId, r]));
		expect((await byChannel()).get(good.channel.id)!.status).toBe('succeeded');
		expect((await byChannel()).get(bad.channel.id)!.status).toBe('pending');

		// Retried on schedule until the next attempt would fall past the window.
		let at = NOW;
		for (let i = 0; i < 20; i++) {
			const row = (await byChannel()).get(bad.channel.id)!;
			if (row.status !== 'pending') break;
			at = row.nextAttemptAt!;
			await notifyDue(db, config, at);
		}
		const final = (await byChannel()).get(bad.channel.id)!;
		expect(final).toMatchObject({ status: 'failed', nextAttemptAt: null, lastError: 'http_5xx' });
		expect(at).toBeLessThanOrEqual(NOW + NOTIFY_RETRY_WINDOW_MS);
		expect(sent.filter((s) => s.url === DISCORD_URL)).toHaveLength(1);
	});

	it('a retry waiting when its channel is paused is dropped without a request', async () => {
		const db = createTestDb();
		const { project } = await seed(db, { now: NOW });
		const { channel } = await addDiscord(db, project.id);
		const sent = stubFetch(() => new Response('no', { status: 500 }));
		await pay(db, project.id);
		await notifyFresh({ db, config, now: NOW });
		await setChannelEnabled(db, project.id, channel.id, false, NOW + 1);
		await notifyDue(db, config, NOW + MIN);
		expect(sent).toHaveLength(1);
		expect((await rowsOf(db))[0]).toMatchObject({ status: 'failed', lastError: 'channel_paused', attempts: 1 });
	});

	it('two passes at once send a notification once', async () => {
		const db = createTestDb();
		const { project } = await seed(db, { now: NOW });
		await addDiscord(db, project.id);
		const sent = stubFetch(() => new Response(null, { status: 204 }));
		await pay(db, project.id);
		await Promise.all([notifyFresh({ db, config, now: NOW }), notifyDue(db, config, NOW), notifyFresh({ db, config, now: NOW })]);
		expect(sent).toHaveLength(1);
		expect(await rowsOf(db)).toHaveLength(1);
	});

	it('a network error is recorded by class and never throws', async () => {
		const db = createTestDb();
		const { project } = await seed(db, { now: NOW });
		const { channel } = await addChannel(db, project.id, { kind: 'telegram', botToken: TELEGRAM_TOKEN, chatId: '42' });
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError(`fetch failed for bot${TELEGRAM_TOKEN}`))));
		await pay(db, project.id);
		await expect(notifyFresh({ db, config, now: NOW })).resolves.toBe(1);
		expect((await rowsOf(db))[0]!.lastError).toBe('network');
		expect(JSON.stringify(await channelOf(db, channel.id))).not.toContain(TELEGRAM_TOKEN);
	});
});

describe('purgeNotifications', () => {
	it('drops rows older than the retention and keeps the rest', async () => {
		const db = createTestDb();
		const { project } = await seed(db, { now: NOW });
		await addDiscord(db, project.id);
		stubFetch();
		await pay(db, project.id);
		await notifyFresh({ db, config, now: NOW });
		await purgeNotifications(db, NOW + NOTIFY_RETENTION_MS - 1);
		expect(await rowsOf(db)).toHaveLength(1);
		await purgeNotifications(db, NOW + NOTIFY_RETENTION_MS + 1);
		expect(await rowsOf(db)).toHaveLength(0);
	});
});
