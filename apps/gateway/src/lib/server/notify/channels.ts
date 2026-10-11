/**
 * Notification channels: what each kind keeps as credentials and how it is
 * read back. The credentials are one encrypted JSON blob per channel
 * (`notify_channel.config_enc`); nothing here is ever logged or shown again.
 *
 * Reachable from the cron (`cron.ts` → `dispatch.ts`), so no `$lib` imports.
 */
import { decrypt, encrypt } from '../crypto';
import type { NotifyChannel, NotifyChannelKind } from '../schema';

export type DiscordConfig = { kind: 'discord'; url: string };
export type TelegramConfig = { kind: 'telegram'; botToken: string; chatId: string; threadId?: number };
export type WebhookConfig = { kind: 'webhook'; url: string; secret: string };
export type ChannelConfig = DiscordConfig | TelegramConfig | WebhookConfig;

export const CHANNEL_KIND_NAMES: Record<NotifyChannelKind, string> = {
	discord: 'Discord',
	telegram: 'Telegram',
	webhook: 'Webhook'
};

export const encryptChannelConfig = (config: ChannelConfig, key: string): Promise<string> =>
	encrypt(JSON.stringify(config), key);

/** The channel's credentials. Throws when the blob cannot be read or is not this channel's kind. */
export async function channelConfig(channel: Pick<NotifyChannel, 'kind' | 'configEnc'>, key: string): Promise<ChannelConfig> {
	const config = JSON.parse(await decrypt(channel.configEnc, key)) as ChannelConfig;
	if (config.kind !== channel.kind) throw new Error('channel config does not match its kind');
	return config;
}
