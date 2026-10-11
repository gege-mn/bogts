/**
 * One send of a notification to one channel. Never throws; the answer is the
 * same `AttemptOutcome` a webhook delivery gets (a short error class, never a
 * URL or a token).
 *
 * Reachable from the cron, so no `$lib` imports.
 */
import { postWebhook, signPayload, USER_AGENT, type AttemptOutcome } from '../events/deliver';
import type { ChannelConfig } from './channels';
import { discordMessage, telegramText, type NotificationBody } from './message';

export const NOTIFICATION_ID_HEADER = 'Bogts-Notification-Id';
export const NOTIFICATION_TYPE_HEADER = 'Bogts-Notification-Type';

const JSON_HEADERS = { 'content-type': 'application/json', 'user-agent': USER_AGENT };

export async function sendNotification(config: ChannelConfig, body: NotificationBody): Promise<AttemptOutcome> {
	switch (config.kind) {
		case 'discord':
			return postWebhook(config.url, JSON.stringify(discordMessage(body)), JSON_HEADERS);
		case 'telegram':
			return postWebhook(
				`https://api.telegram.org/bot${config.botToken}/sendMessage`,
				JSON.stringify({
					chat_id: config.chatId,
					...(config.threadId ? { message_thread_id: config.threadId } : {}),
					text: telegramText(body),
					parse_mode: 'HTML',
					link_preview_options: { is_disabled: true }
				}),
				JSON_HEADERS
			);
		case 'webhook': {
			const json = JSON.stringify(body);
			// The real clock: receivers check it against theirs.
			const signature = await signPayload(config.secret, Math.floor(Date.now() / 1000), json);
			return postWebhook(config.url, json, {
				...JSON_HEADERS,
				'Bogts-Signature': signature,
				[NOTIFICATION_ID_HEADER]: body.id,
				[NOTIFICATION_TYPE_HEADER]: body.type
			});
		}
	}
}
