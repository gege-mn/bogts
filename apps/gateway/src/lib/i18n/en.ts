/**
 * Dashboard strings, flat keys (ux-brief §15). Statuses, navigation and the
 * shared components live here; a later `mn.ts` mirrors it. Use `t(key, vars)`.
 */
export const en = {
	'nav.overview': 'Overview',
	'nav.payments': 'Payments',
	'nav.subscriptions': 'Subscriptions',
	'nav.charges': 'Charges',
	'nav.cards': 'Cards',
	'nav.events': 'Events',
	'nav.projects': 'Projects',
	'nav.usage': 'Usage',
	'nav.settings': 'Settings',
	'nav.signOut': 'Sign out',
	'nav.allProjects': 'All projects',
	'nav.search': 'Search by id',

	'status.invoice.pending': 'Pending',
	'status.invoice.paid': 'Paid',
	'status.invoice.expired': 'Expired',
	'status.invoice.failed': 'Failed',
	'status.invoice.cancelled': 'Cancelled',
	'status.subscription.pending': 'Awaiting card',
	'status.subscription.active': 'Active',
	'status.subscription.past_due': 'Payment failed',
	'status.subscription.cancelled': 'Cancelled',
	'status.subscription.failed': 'Failed',
	'status.charge.pending': 'Processing',
	'status.charge.queued': 'Processing',
	'status.charge.succeeded': 'Succeeded',
	'status.charge.failed': 'Failed',
	'status.charge.reversed': 'Reversed',
	'status.card.pending': 'Awaiting card',
	'status.card.active': 'Active',
	'status.card.failed': 'Failed',
	'status.card.removed': 'Removed',
	'status.delivery.queued': 'Queued',
	'status.delivery.succeeded': 'Delivered',
	'status.delivery.retrying': 'Retrying',
	'status.delivery.failed': 'Failed',
	'status.delivery.skipped': 'Not sent',
	'status.plan.verified': 'Verified',
	'status.plan.mismatch': 'Mismatch',
	'status.plan.unchecked': 'Not checked',
	'status.plan.error': 'Check failed',
	'status.plan.inactive': 'Inactive',
	'status.provider.configured': 'Configured',
	'status.provider.incomplete': 'Incomplete',
	'status.provider.off': 'Off',
	'status.env.test': 'Sandbox',
	'status.env.production': 'Production',
	'status.project.active': 'Active',
	'status.project.archived': 'Archived',

	'copy.copy': 'Copy',
	'copy.copied': 'Copied',
	'common.none': '—',
	'common.back': 'Back',
	'common.newer': '← Newer',
	'common.older': 'Older →',
	'common.all': 'All'
} as const;

export type MessageKey = keyof typeof en;

/** The string for `key`, with `{name}` placeholders filled. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
	return en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
