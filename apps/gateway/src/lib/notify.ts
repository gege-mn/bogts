/**
 * Notification channels, as the dashboard words them. The keys mirror
 * `NOTIFY_CHANNEL_KINDS` and `NOTIFICATION_TYPES` in `server/schema.ts` (a
 * test checks), which components cannot import.
 */
export const CHANNEL_KINDS = [
	{ kind: 'discord', name: 'Discord', icon: 'hash', about: 'A channel, through a webhook' },
	{ kind: 'telegram', name: 'Telegram', icon: 'send', about: 'A chat, through your bot' },
	{ kind: 'webhook', name: 'Webhook', icon: 'webhook', about: 'Signed JSON to your URL' }
] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number]['kind'];

export const channelKind = (kind: string) => CHANNEL_KINDS.find((k) => k.kind === kind) ?? CHANNEL_KINDS[2];
/** What a channel can be notified about, in the order the form lists them. */
export const NOTIFICATION_TYPE_OPTIONS = [
	{ type: 'payment.received', label: 'Payments received', hint: 'A paid invoice, a subscription payment or a card charge' }
] as const;

export const notificationTypeLabel = (type: string): string => NOTIFICATION_TYPE_OPTIONS.find((t) => t.type === type)?.label ?? type;

/** A channel as the dashboard lists it: never its credentials. */
export type ChannelRow = {
	id: string;
	kind: string;
	label: string;
	hint: string;
	types: string[];
	enabled: boolean;
	lastSentAt: number | null;
	lastError: string | null;
	lastErrorAt: number | null;
};

const SEND_ERRORS: Record<string, string> = {
	timeout: 'no answer within 10 seconds',
	dns: 'the address could not be found',
	tls: 'the secure connection failed',
	connection_refused: 'the connection was refused',
	connection_reset: 'the connection dropped',
	invalid_url: 'the address is not valid',
	network: 'it could not be reached',
	http_3xx: 'it answered with a redirect',
	http_4xx: 'it refused the message',
	http_5xx: 'it answered with an error',
	config_unavailable: 'the saved credentials cannot be read'
};

/** A channel's last send error (`timeout`, `http_4xx`, …) in words. */
export const sendErrorText = (error: string): string => SEND_ERRORS[error] ?? error;
