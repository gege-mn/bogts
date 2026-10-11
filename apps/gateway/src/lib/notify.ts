/**
 * Notification channels, as the dashboard words them. The keys mirror
 * `NOTIFY_CHANNEL_KINDS` and `NOTIFICATION_TYPES` in `server/schema.ts` (a
 * test checks), which components cannot import.
 */
export const CHANNEL_KINDS = [
	{ kind: 'discord', name: 'Discord' },
	{ kind: 'telegram', name: 'Telegram' },
	{ kind: 'webhook', name: 'Webhook (JSON)' }
] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number]['kind'];

export const channelKindName = (kind: string): string => CHANNEL_KINDS.find((k) => k.kind === kind)?.name ?? kind;

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
