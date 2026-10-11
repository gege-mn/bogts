import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { channelConfig } from '../notify/channels';
import { notification, notifyChannel } from '../schema';
import { createTestDb, seedProject, testConfig, TEST_ENCRYPTION_KEY, type TestDb } from '../testdb';
import {
	MAX_CHANNELS,
	createChannel,
	deleteChannel,
	findTelegramChats,
	globalChannelCount,
	listChannels,
	parseChannelInput,
	parseDiscordUrl,
	parseTelegram,
	setChannelEnabled,
	testChannel,
	updateChannel
} from './notify';

const NOW = 1_800_000_000_000;
const config = testConfig();
const DISCORD_URL = 'https://discord.com/api/webhooks/123456789012345678/abc-DEF_token';
const TELEGRAM_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';

afterEach(() => vi.unstubAllGlobals());

function form(fields: Record<string, string>, types = ['payment.received']) {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	for (const t of types) f.append('types', t);
	return f;
}

const add = (db: TestDb, projectId: string | null, fields: Record<string, string> = { kind: 'discord', url: DISCORD_URL }) =>
	createChannel(db, TEST_ENCRYPTION_KEY, projectId, parseChannelInput(form(fields), false), NOW);

const rejects = (fn: () => unknown, status = 400) => {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(status);
		return;
	}
	throw new Error('expected an ApiError');
};

describe('parsing a channel form', () => {
	it('Discord: only a webhook URL of Discord, normalised, with a secret-free hint', () => {
		expect(parseDiscordUrl(` ${DISCORD_URL} `)).toEqual({ config: { kind: 'discord', url: DISCORD_URL }, hint: 'Webhook …5678' });
		expect(parseDiscordUrl('https://canary.discord.com/api/v10/webhooks/42/tok?thread_id=77&wait=true').config.url).toBe(
			'https://discord.com/api/webhooks/42/tok?thread_id=77'
		);
		for (const url of ['', 'not a url', 'http://discord.com/api/webhooks/1/t', 'https://evil.test/api/webhooks/1/t', 'https://discord.com/channels/1/2', `${DISCORD_URL}?thread_id=x`]) {
			rejects(() => parseDiscordUrl(url));
		}
	});

	it('Telegram: a bot token, a chat and an optional topic', () => {
		expect(parseTelegram(TELEGRAM_TOKEN, ' -1001234567890 ', '')).toEqual({
			config: { kind: 'telegram', botToken: TELEGRAM_TOKEN, chatId: '-1001234567890' },
			hint: 'Chat -1001234567890'
		});
		expect(parseTelegram(TELEGRAM_TOKEN, '@gege_money', '12')).toMatchObject({ config: { chatId: '@gege_money', threadId: 12 }, hint: 'Chat @gege_money · topic 12' });
		rejects(() => parseTelegram('nope', '1', ''));
		rejects(() => parseTelegram(TELEGRAM_TOKEN, 'my chat', ''));
		rejects(() => parseTelegram(TELEGRAM_TOKEN, '1', 'abc'));
	});

	it('the name defaults to the kind, and at least one known type is needed', () => {
		expect(parseChannelInput(form({ kind: 'discord', url: DISCORD_URL }), false)).toMatchObject({ label: 'Discord', types: ['payment.received'] });
		expect(parseChannelInput(form({ kind: 'discord', url: DISCORD_URL, label: '  #money  ' }), false).label).toBe('#money');
		rejects(() => parseChannelInput(form({ kind: 'discord', url: DISCORD_URL }, []), false));
		rejects(() => parseChannelInput(form({ kind: 'discord', url: DISCORD_URL }, ['nope']), false));
		rejects(() => parseChannelInput(form({ kind: 'discord', url: DISCORD_URL, label: 'x'.repeat(61) }), false));
		rejects(() => parseChannelInput(form({ kind: 'slack', url: DISCORD_URL }), false));
	});

	it('Webhook: https only (http://localhost in sandbox), and the hint is the host alone', () => {
		expect(parseChannelInput(form({ kind: 'webhook', url: 'https://ops.test/hooks/s3cret-path' }), false)).toMatchObject({
			config: { kind: 'webhook', url: 'https://ops.test/hooks/s3cret-path' },
			hint: 'ops.test'
		});
		rejects(() => parseChannelInput(form({ kind: 'webhook', url: '' }), false));
		rejects(() => parseChannelInput(form({ kind: 'webhook', url: 'http://localhost:3000/x' }), false));
		expect(parseChannelInput(form({ kind: 'webhook', url: 'http://localhost:3000/x' }), true).hint).toBe('localhost:3000');
	});
});

describe('channels', () => {
	it('are stored encrypted and listed without credentials, per scope', async () => {
		const db = createTestDb();
		const { project } = await seedProject(db, { now: NOW });
		const own = await add(db, project.id, { kind: 'telegram', botToken: TELEGRAM_TOKEN, chatId: '42', label: 'Ops' });
		const global = await add(db, null);
		const hook = await add(db, null, { kind: 'webhook', url: 'https://ops.test/hook' });
		expect(own.secret).toBeNull();
		expect(hook.secret).toMatch(/^bgwh_[0-9A-Za-z]{32}$/);

		const stored = JSON.stringify(await db.select().from(notifyChannel));
		for (const secret of [TELEGRAM_TOKEN, 'abc-DEF_token', hook.secret!]) expect(stored).not.toContain(secret);
		expect(await channelConfig(own.channel, TEST_ENCRYPTION_KEY)).toEqual({ kind: 'telegram', botToken: TELEGRAM_TOKEN, chatId: '42' });
		expect(await channelConfig(hook.channel, TEST_ENCRYPTION_KEY)).toEqual({ kind: 'webhook', url: 'https://ops.test/hook', secret: hook.secret });

		expect(await listChannels(db, project.id)).toEqual([
			{ id: own.channel.id, kind: 'telegram', label: 'Ops', hint: 'Chat 42', types: ['payment.received'], enabled: true, lastSentAt: null, lastError: null, lastErrorAt: null, createdAt: NOW }
		]);
		expect((await listChannels(db, null)).map((c) => c.id)).toEqual([global.channel.id, hook.channel.id]);
	});

	it('can only be changed from their own scope', async () => {
		const db = createTestDb();
		const a = await seedProject(db, { now: NOW });
		const b = await seedProject(db, { now: NOW });
		const own = await add(db, a.project.id);
		const global = await add(db, null);
		for (const [scope, id] of [
			[b.project.id, own.channel.id],
			[null, own.channel.id],
			[a.project.id, global.channel.id],
			[a.project.id, 'not-an-id']
		] as const) {
			await expect(deleteChannel(db, scope, id)).rejects.toMatchObject({ status: 404 });
			await expect(setChannelEnabled(db, scope, id, false)).rejects.toMatchObject({ status: 404 });
			await expect(updateChannel(db, scope, id, form({ label: 'x' }))).rejects.toMatchObject({ status: 404 });
			await expect(testChannel(db, config, scope, id)).rejects.toMatchObject({ status: 404 });
		}
		await expect(add(db, '01ARZ3NDEKTSV4RRFFQ69G5FAV')).rejects.toMatchObject({ status: 404 });
	});

	it('rename, pause and resume (which restarts what it hears about), delete', async () => {
		const db = createTestDb();
		const { project } = await seedProject(db, { now: NOW });
		const { channel } = await add(db, project.id);
		await updateChannel(db, project.id, channel.id, form({ label: 'Money' }), NOW + 1);
		await setChannelEnabled(db, project.id, channel.id, false, NOW + 2);
		expect((await listChannels(db, project.id))[0]).toMatchObject({ label: 'Money', enabled: false });
		await setChannelEnabled(db, project.id, channel.id, true, NOW + 3);
		expect((await db.select().from(notifyChannel))[0]).toMatchObject({ enabled: true, activeFrom: NOW + 3 });

		await db.insert(notification).values({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', channelId: channel.id, type: 'payment.received', sourceId: 'x', createdAt: NOW, updatedAt: NOW });
		await deleteChannel(db, project.id, channel.id);
		expect(await db.select().from(notifyChannel)).toHaveLength(0);
		expect(await db.select().from(notification)).toHaveLength(0);
	});

	it(`at most ${MAX_CHANNELS} per scope`, async () => {
		const db = createTestDb();
		for (let i = 0; i < MAX_CHANNELS; i++) await add(db, null);
		await expect(add(db, null)).rejects.toMatchObject({ status: 409 });
		const { project } = await seedProject(db, { now: NOW });
		await expect(add(db, project.id)).resolves.toBeTruthy();
	});
});

describe('testChannel', () => {
	it('sends a marked test message and records the result on the channel', async () => {
		const db = createTestDb();
		const { project } = await seedProject(db, { name: 'Sarvuu', now: NOW });
		const { channel } = await add(db, project.id);
		const bodies: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => (bodies.push(String(init?.body)), new Response(null, { status: 204 }))));
		expect(await testChannel(db, config, project.id, channel.id, NOW + 5)).toEqual({ ok: true, error: null, detail: null });
		const [embed] = JSON.parse(bodies[0]!).embeds;
		expect(embed.title).toBe('[Test] ₮10,000 received');
		expect(embed.description).toContain('Sarvuu');
		expect((await listChannels(db, project.id))[0]).toMatchObject({ lastSentAt: NOW + 5, lastError: null });
		// A test is not a notification: nothing is queued.
		expect(await db.select().from(notification)).toHaveLength(0);
	});

	it('says what the receiver answered when it refuses', async () => {
		const db = createTestDb();
		const { channel } = await add(db, null, { kind: 'telegram', botToken: TELEGRAM_TOKEN, chatId: '42' });
		vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, { status: 400 })));
		expect(await testChannel(db, config, null, channel.id, NOW)).toEqual({ ok: false, error: 'http_4xx', detail: 'Bad Request: chat not found' });
		expect((await listChannels(db, null))[0]).toMatchObject({ lastError: 'http_4xx', lastErrorAt: NOW });
	});
});

describe('findTelegramChats', () => {
	const update = (chat: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ update_id: 1, message: { chat, ...extra } });

	it('lists the chats the bot has seen, newest first, each once', async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL) => {
				calls.push(String(url));
				return Response.json({
					ok: true,
					result: [
						update({ id: 42, first_name: 'Bat', type: 'private' }),
						update({ id: -1001, title: 'Money', type: 'supergroup' }),
						{ update_id: 3, channel_post: { chat: { id: -1002, title: 'Announcements', type: 'channel' } } },
						update({ id: -1001, title: 'Money', type: 'supergroup' }, { is_topic_message: true, message_thread_id: 7 }),
						update({ id: -1001, title: 'Money', type: 'supergroup' }),
						{ update_id: 9, my_chat_member: { chat: { id: -1003, title: 'New group', type: 'group' } } },
						{ update_id: 10, something_else: {} }
					]
				});
			})
		);
		expect(await findTelegramChats(` ${TELEGRAM_TOKEN} `)).toEqual([
			{ chatId: '-1003', title: 'New group', type: 'group', threadId: null },
			{ chatId: '-1001', title: 'Money', type: 'supergroup', threadId: null },
			{ chatId: '-1001', title: 'Money', type: 'supergroup', threadId: 7 },
			{ chatId: '-1002', title: 'Announcements', type: 'channel', threadId: null },
			{ chatId: '42', title: 'Bat', type: 'private', threadId: null }
		]);
		expect(calls).toEqual([`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`]);
	});

	it('says what is wrong in words, and never repeats the token', async () => {
		const failing = async (respond: () => Response | Promise<Response>) => {
			vi.stubGlobal('fetch', vi.fn(async () => respond()));
			const err = await findTelegramChats(TELEGRAM_TOKEN).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).message).not.toContain(TELEGRAM_TOKEN);
			return err as ApiError;
		};
		await expect(findTelegramChats('nope')).rejects.toMatchObject({ status: 400 });
		expect((await failing(() => Response.json({ ok: false }, { status: 401 }))).status).toBe(400);
		expect((await failing(() => Response.json({ ok: false }, { status: 409 }))).message).toContain('webhook');
		expect((await failing(() => new Response('<html>', { status: 200 }))).status).toBe(502);
		expect((await failing(() => Promise.reject(new TypeError(`fetch failed bot${TELEGRAM_TOKEN}`)))).status).toBe(502);
	});
});

describe('globalChannelCount', () => {
	it('counts enabled global channels only', async () => {
		const db = createTestDb();
		const { project } = await seedProject(db, { now: NOW });
		await add(db, project.id);
		await add(db, null);
		const paused = await add(db, null);
		await setChannelEnabled(db, null, paused.channel.id, false);
		expect(await globalChannelCount(db)).toBe(1);
	});
});
