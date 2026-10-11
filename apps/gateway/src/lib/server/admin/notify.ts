/**
 * Notification channels for the dashboard: the form parsing, the reads and
 * writes, Send test, and the form actions the Settings page (global channels)
 * and a project's page (its own channels) share.
 *
 * Every write names its scope (`projectId`, or null for global) and only
 * touches a channel of that scope, so a project's page can never change a
 * global channel or another project's.
 */
import { fail } from '@sveltejs/kit';
import { and, count, eq, isNull } from 'drizzle-orm';
import { ApiError } from '../api/errors';
import { recordAudit } from '../audit';
import type { DB } from '../db';
import type { Config } from '../env';
import { newId, newWebhookSecret } from '../ids';
import {
	CHANNEL_KIND_NAMES,
	channelConfig,
	encryptChannelConfig,
	type ChannelConfig,
	type DiscordConfig,
	type TelegramConfig
} from '../notify/channels';
import { testBody } from '../notify/message';
import { sendNotification } from '../notify/send';
import {
	NOTIFICATION_TYPES,
	NOTIFY_CHANNEL_KINDS,
	notification,
	notifyChannel,
	project,
	type NotificationType,
	type NotifyChannel,
	type NotifyChannelKind
} from '../schema';
import { sendErrorText } from '$lib/notify';
import { adminContext, failFrom } from './actions';
import { isId } from './common';
import { allowsLocalWebhooks } from './health';
import { parseWebhookUrl } from './projects';

/** Channels per scope (one project, or global). Every payment is sent to each. */
export const MAX_CHANNELS = 20;
const LABEL_MAX = 60;

/* ------------------------------------------------------------------ *
 * Validation of inputs
 * ------------------------------------------------------------------ */

const bad = (message: string) => new ApiError(400, 'invalid_request', message);

const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
const DISCORD_PATH = /^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)\/?$/;

/** A Discord webhook URL, rebuilt from its id and token (a `thread_id` is kept). */
export function parseDiscordUrl(raw: string): { config: DiscordConfig; hint: string } {
	const example = 'Paste the webhook URL from Discord, like https://discord.com/api/webhooks/…';
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw bad(example);
	}
	const match = DISCORD_PATH.exec(url.pathname);
	if (url.protocol !== 'https:' || !DISCORD_HOSTS.has(url.hostname) || !match) throw bad(example);
	const thread = url.searchParams.get('thread_id');
	if (thread !== null && !/^\d+$/.test(thread)) throw bad('thread_id in the URL must be a number');
	const [, id, token] = match;
	return {
		config: { kind: 'discord', url: `https://discord.com/api/webhooks/${id}/${token}${thread ? `?thread_id=${thread}` : ''}` },
		hint: `Webhook …${id!.slice(-4)}${thread ? ' · thread' : ''}`
	};
}

const TELEGRAM_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_CHAT = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,})$/;

/** A Telegram bot token, the chat it writes to, and optionally a topic of that chat. */
export function parseTelegram(rawToken: string, rawChat: string, rawThread: string): { config: TelegramConfig; hint: string } {
	const botToken = rawToken.trim();
	const chatId = rawChat.trim();
	const thread = rawThread.trim();
	if (!TELEGRAM_TOKEN.test(botToken)) throw bad('Enter the bot token from @BotFather, like 123456789:AA…');
	if (!TELEGRAM_CHAT.test(chatId)) throw bad('Enter the chat id (a number, negative for groups) or a public @channel name');
	if (thread && !/^[1-9]\d{0,15}$/.test(thread)) throw bad('The topic id must be a number');
	return {
		config: { kind: 'telegram', botToken, chatId, ...(thread ? { threadId: Number(thread) } : {}) },
		hint: `Chat ${chatId}${thread ? ` · topic ${thread}` : ''}`
	};
}

/** The label (defaults to the kind's name) and the notification types of a channel form. */
function parseLabelAndTypes(form: FormData, kind: NotifyChannelKind): { label: string; types: NotificationType[] } {
	const label = String(form.get('label') ?? '').trim() || CHANNEL_KIND_NAMES[kind];
	if (label.length > LABEL_MAX) throw bad(`Keep the name under ${LABEL_MAX} characters`);
	const wanted = new Set(form.getAll('types').map(String));
	const types = NOTIFICATION_TYPES.filter((t) => wanted.has(t));
	if (types.length === 0) throw bad('Pick at least one thing to be notified about');
	return { label, types };
}

export type ChannelInput = {
	kind: NotifyChannelKind;
	label: string;
	types: NotificationType[];
	/** A webhook channel's signing secret is minted on creation, not typed */
	config: DiscordConfig | TelegramConfig | { kind: 'webhook'; url: string };
	hint: string;
};

export function parseChannelInput(form: FormData, allowLocalHttp: boolean): ChannelInput {
	const kind = String(form.get('kind') ?? '') as NotifyChannelKind;
	if (!NOTIFY_CHANNEL_KINDS.includes(kind)) throw bad('Pick Discord, Telegram or Webhook');
	const base = { kind, ...parseLabelAndTypes(form, kind) };
	const field = (name: string) => String(form.get(name) ?? '');
	if (kind === 'discord') return { ...base, ...parseDiscordUrl(field('url')) };
	if (kind === 'telegram') return { ...base, ...parseTelegram(field('botToken'), field('chatId'), field('threadId')) };
	const url = parseWebhookUrl(field('url'), allowLocalHttp);
	if (!url) throw bad('Enter the URL to POST notifications to');
	return { ...base, config: { kind: 'webhook', url }, hint: new URL(url).host };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

const scopeOf = (projectId: string | null) => (projectId === null ? isNull(notifyChannel.projectId) : eq(notifyChannel.projectId, projectId));

export type ChannelView = Pick<
	NotifyChannel,
	'id' | 'kind' | 'label' | 'hint' | 'types' | 'enabled' | 'lastSentAt' | 'lastError' | 'lastErrorAt' | 'createdAt'
>;

/** The channels of a project, or the global ones (`projectId` null), oldest first. Never the credentials. */
export function listChannels(db: DB, projectId: string | null): Promise<ChannelView[]> {
	return db
		.select({
			id: notifyChannel.id,
			kind: notifyChannel.kind,
			label: notifyChannel.label,
			hint: notifyChannel.hint,
			types: notifyChannel.types,
			enabled: notifyChannel.enabled,
			lastSentAt: notifyChannel.lastSentAt,
			lastError: notifyChannel.lastError,
			lastErrorAt: notifyChannel.lastErrorAt,
			createdAt: notifyChannel.createdAt
		})
		.from(notifyChannel)
		.where(scopeOf(projectId))
		.orderBy(notifyChannel.id);
}

/** How many enabled global channels there are: a project's page says they hear about it too. */
export async function globalChannelCount(db: DB): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(notifyChannel)
		.where(and(isNull(notifyChannel.projectId), eq(notifyChannel.enabled, true)));
	return row?.n ?? 0;
}

async function mustChannel(db: DB, projectId: string | null, id: string): Promise<NotifyChannel> {
	const [row] = isId(id)
		? await db
				.select()
				.from(notifyChannel)
				.where(and(eq(notifyChannel.id, id), scopeOf(projectId)))
				.limit(1)
		: [];
	if (!row) throw new ApiError(404, 'not_found', 'Channel not found');
	return row;
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * Adds a channel. A webhook channel gets a fresh signing secret, returned
 * here once (`secret`) and never readable again.
 */
export async function createChannel(
	db: DB,
	encryptionKey: string,
	projectId: string | null,
	input: ChannelInput,
	now = Date.now()
): Promise<{ channel: NotifyChannel; secret: string | null }> {
	if (projectId !== null) {
		const [p] = await db.select({ id: project.id }).from(project).where(eq(project.id, projectId)).limit(1);
		if (!p) throw new ApiError(404, 'not_found', 'Project not found');
	}
	const existing = await db.select({ id: notifyChannel.id }).from(notifyChannel).where(scopeOf(projectId));
	if (existing.length >= MAX_CHANNELS) throw new ApiError(409, 'conflict', `At most ${MAX_CHANNELS} channels here. Delete one first.`);
	const secret = input.config.kind === 'webhook' ? newWebhookSecret() : null;
	const config: ChannelConfig = input.config.kind === 'webhook' ? { ...input.config, secret: secret! } : input.config;
	const [channel] = await db
		.insert(notifyChannel)
		.values({
			id: newId(),
			projectId,
			kind: input.kind,
			label: input.label,
			configEnc: await encryptChannelConfig(config, encryptionKey),
			hint: input.hint,
			types: input.types,
			enabled: true,
			activeFrom: now,
			createdAt: now,
			updatedAt: now
		})
		.returning();
	return { channel: channel!, secret };
}

/** Renames a channel and sets what it is notified about. Its credentials never change: delete and add again. */
export async function updateChannel(db: DB, projectId: string | null, id: string, form: FormData, now = Date.now()): Promise<NotifyChannel> {
	const channel = await mustChannel(db, projectId, id);
	const { label, types } = parseLabelAndTypes(form, channel.kind);
	await db.update(notifyChannel).set({ label, types, updatedAt: now }).where(eq(notifyChannel.id, channel.id));
	return { ...channel, label, types };
}

/**
 * Pauses or resumes a channel. Resuming moves `activeFrom` to now, so what
 * happened while it was paused is never sent.
 */
export async function setChannelEnabled(db: DB, projectId: string | null, id: string, enabled: boolean, now = Date.now()): Promise<NotifyChannel> {
	const channel = await mustChannel(db, projectId, id);
	if (channel.enabled === enabled) return channel;
	await db
		.update(notifyChannel)
		.set(enabled ? { enabled, activeFrom: now, lastError: null, lastErrorAt: null, updatedAt: now } : { enabled, updatedAt: now })
		.where(eq(notifyChannel.id, channel.id));
	return { ...channel, enabled };
}

/** Deletes a channel and its notification rows (sent or still waiting). */
export async function deleteChannel(db: DB, projectId: string | null, id: string): Promise<NotifyChannel> {
	const channel = await mustChannel(db, projectId, id);
	await db.batch([
		db.delete(notification).where(eq(notification.channelId, channel.id)),
		db.delete(notifyChannel).where(eq(notifyChannel.id, channel.id))
	]);
	return channel;
}

export type ChannelTestResult = { ok: boolean; error: string | null; detail: string | null };

/** What the receiver said about a refused message, when it said it in JSON (Telegram `description`, Discord `message`). */
function refusalDetail(responseBody: string | null): string | null {
	if (!responseBody) return null;
	try {
		const parsed = JSON.parse(responseBody) as { description?: unknown; message?: unknown };
		const text = typeof parsed.description === 'string' ? parsed.description : typeof parsed.message === 'string' ? parsed.message : null;
		return text ? text.slice(0, 200) : null;
	} catch {
		return null;
	}
}

/** Sends a made-up payment to the channel now (paused or not) and records how it went on the channel. */
export async function testChannel(db: DB, config: Config, projectId: string | null, id: string, now = Date.now()): Promise<ChannelTestResult> {
	const channel = await mustChannel(db, projectId, id);
	const [p] =
		channel.projectId === null
			? []
			: await db.select({ id: project.id, name: project.name, slug: project.slug }).from(project).where(eq(project.id, channel.projectId)).limit(1);
	let credentials: ChannelConfig;
	try {
		credentials = await channelConfig(channel, config.encryptionKey);
	} catch {
		return { ok: false, error: 'config_unavailable', detail: 'The saved credentials cannot be read. Delete the channel and add it again.' };
	}
	const outcome = await sendNotification(credentials, testBody(config, newId(), p ?? null, now));
	await db
		.update(notifyChannel)
		.set(outcome.ok ? { lastSentAt: now, lastError: null, lastErrorAt: null } : { lastError: outcome.error, lastErrorAt: now })
		.where(eq(notifyChannel.id, channel.id));
	return { ok: outcome.ok, error: outcome.error, detail: outcome.ok ? null : refusalDetail(outcome.responseBody) };
}

/* ------------------------------------------------------------------ *
 * Telegram: which chats can this bot write to?
 * ------------------------------------------------------------------ */

export type TelegramChat = { chatId: string; title: string; type: string; threadId: number | null };

const TELEGRAM_LOOKUP_TIMEOUT_MS = 10_000;
const TELEGRAM_CHATS_MAX = 12;

type TelegramChatJson = { id?: unknown; title?: unknown; username?: unknown; first_name?: unknown; type?: unknown };
type TelegramUpdate = Record<string, { chat?: TelegramChatJson; message_thread_id?: unknown; is_topic_message?: unknown } | undefined>;

/**
 * The chats a bot was recently written to in or added to (Telegram's
 * `getUpdates`), newest first, so the form can offer them in place of a chat
 * id typed by hand. Nothing is stored and no update is consumed. Throws an
 * `ApiError` with words for the form; the token never appears in one.
 */
export async function findTelegramChats(rawToken: string): Promise<TelegramChat[]> {
	const botToken = rawToken.trim();
	if (!TELEGRAM_TOKEN.test(botToken)) throw bad('Enter the bot token from @BotFather first, like 123456789:AA…');
	let res: Response;
	try {
		res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ limit: 100, timeout: 0, allowed_updates: ['message', 'channel_post', 'my_chat_member'] }),
			signal: AbortSignal.timeout(TELEGRAM_LOOKUP_TIMEOUT_MS)
		});
	} catch {
		throw new ApiError(502, 'provider_error', 'Telegram could not be reached. Try again.');
	}
	if (res.status === 401 || res.status === 404) throw bad('Telegram does not know this bot token. Copy it again from @BotFather.');
	if (res.status === 409) {
		throw new ApiError(409, 'conflict', 'This bot has a webhook set, so its chats cannot be listed. Type the chat id instead.');
	}
	let updates: TelegramUpdate[];
	try {
		const json = (await res.json()) as { ok?: unknown; result?: unknown };
		if (!res.ok || json.ok !== true || !Array.isArray(json.result)) throw new Error('unexpected answer');
		updates = json.result as TelegramUpdate[];
	} catch {
		throw new ApiError(502, 'provider_error', 'Telegram gave an answer that could not be read. Type the chat id instead.');
	}
	const chats = new Map<string, TelegramChat>();
	for (const update of [...updates].reverse()) {
		const part = update.message ?? update.channel_post ?? update.my_chat_member;
		const chat = part?.chat;
		if (!chat || (typeof chat.id !== 'number' && typeof chat.id !== 'string')) continue;
		const threadId = part.is_topic_message === true && typeof part.message_thread_id === 'number' ? part.message_thread_id : null;
		const key = `${chat.id}:${threadId ?? ''}`;
		if (chats.has(key)) continue;
		const name = [chat.title, chat.first_name, chat.username].find((v): v is string => typeof v === 'string' && v !== '');
		chats.set(key, {
			chatId: String(chat.id),
			title: (name ?? String(chat.id)).slice(0, 80),
			type: typeof chat.type === 'string' ? chat.type : 'chat',
			threadId
		});
		if (chats.size >= TELEGRAM_CHATS_MAX) break;
	}
	return [...chats.values()];
}

/* ------------------------------------------------------------------ *
 * Form actions (Settings: `projectId` null; a project's page: its id)
 * ------------------------------------------------------------------ */

type ActionEvent = { locals: App.Locals; request: Request };

/** A failed test in words, with what the receiver said when it said something. */
const refusalText = (result: ChannelTestResult) =>
	`The test did not go through: ${sendErrorText(result.error ?? 'network')}${result.detail ? ` (${result.detail})` : ''}.`;

export async function addChannelAction({ locals, request }: ActionEvent, projectId: string | null) {
	const { admin, config } = adminContext(locals);
	const form = await request.formData();
	try {
		const input = parseChannelInput(form, allowsLocalWebhooks(config));
		const { channel, secret } = await createChannel(locals.db, config.encryptionKey, projectId, input);
		// The channel exists now, and a webhook's secret can only be shown in this
		// answer: nothing after this point may turn the action into a failure.
		let test: ChannelTestResult | null = null;
		try {
			await recordAudit(locals.db, {
				admin,
				action: 'notify.create',
				subject: channel.id,
				detail: { projectId, kind: channel.kind, label: channel.label, hint: channel.hint, types: channel.types }
			});
			// The form's "send a test now": the channel is kept either way, and the page says how it went.
			if (form.get('test') === '1') test = await testChannel(locals.db, config, projectId, channel.id);
		} catch (err) {
			console.error('[admin] addChannel follow-up failed', err instanceof Error ? err.name : typeof err);
		}
		return {
			action: 'addChannel',
			ok: true,
			...(test ? { test: { ok: test.ok, message: test.ok ? null : refusalText(test) } } : {}),
			...(secret ? { revealed: [{ label: 'Notification signing secret', env: 'BOGTS_NOTIFY_SECRET', value: secret }] } : {})
		};
	} catch (err) {
		return failFrom(err, 'addChannel');
	}
}

export async function updateChannelAction({ locals, request }: ActionEvent, projectId: string | null) {
	const { admin } = adminContext(locals);
	const form = await request.formData();
	try {
		const channel = await updateChannel(locals.db, projectId, String(form.get('channelId') ?? ''), form);
		await recordAudit(locals.db, { admin, action: 'notify.update', subject: channel.id, detail: { label: channel.label, types: channel.types } });
		return { action: 'updateChannel', ok: true };
	} catch (err) {
		return failFrom(err, 'updateChannel');
	}
}

export async function toggleChannelAction({ locals, request }: ActionEvent, projectId: string | null) {
	const { admin } = adminContext(locals);
	const form = await request.formData();
	const enabled = form.get('enabled') === 'true';
	try {
		const channel = await setChannelEnabled(locals.db, projectId, String(form.get('channelId') ?? ''), enabled);
		await recordAudit(locals.db, { admin, action: enabled ? 'notify.resume' : 'notify.pause', subject: channel.id });
		return { action: 'toggleChannel', ok: true };
	} catch (err) {
		return failFrom(err, 'toggleChannel');
	}
}

export async function deleteChannelAction({ locals, request }: ActionEvent, projectId: string | null) {
	const { admin } = adminContext(locals);
	const form = await request.formData();
	try {
		const channel = await deleteChannel(locals.db, projectId, String(form.get('channelId') ?? ''));
		await recordAudit(locals.db, { admin, action: 'notify.delete', subject: channel.id, detail: { projectId, kind: channel.kind, label: channel.label } });
		return { action: 'deleteChannel', ok: true };
	} catch (err) {
		return failFrom(err, 'deleteChannel');
	}
}

export async function testChannelAction({ locals, request }: ActionEvent, projectId: string | null) {
	const { admin, config } = adminContext(locals);
	const form = await request.formData();
	const id = String(form.get('channelId') ?? '');
	try {
		const result = await testChannel(locals.db, config, projectId, id);
		await recordAudit(locals.db, { admin, action: 'notify.test', subject: id, detail: { ok: result.ok, error: result.error } });
		if (!result.ok) return fail(502, { action: 'testChannel', error: refusalText(result) });
		return { action: 'testChannel', ok: true };
	} catch (err) {
		return failFrom(err, 'testChannel');
	}
}

/** The chats of a Telegram bot, for the add form. Scope-free: it reads Telegram, not the database. */
export async function telegramChatsAction({ locals, request }: ActionEvent) {
	adminContext(locals);
	const form = await request.formData();
	try {
		return { action: 'telegramChats', chats: await findTelegramChats(String(form.get('botToken') ?? '')) };
	} catch (err) {
		return failFrom(err, 'telegramChats');
	}
}
