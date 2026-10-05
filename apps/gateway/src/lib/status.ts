/**
 * The status vocabulary (ux-brief §4): each DB status maps to a tone (colour +
 * glyph) and a label. DB values never reach the UI directly.
 */
import { t, type MessageKey } from './i18n/en';

export type Tone = 'success' | 'pending' | 'info' | 'warning' | 'danger' | 'muted';
/** `glyph` overrides the tone's icon where the meaning differs (an environment is not a failure). */
export type StatusView = { tone: Tone; label: string; glyph?: 'live' | 'flask' };

const view = (tone: Tone, key: MessageKey): StatusView => ({ tone, label: t(key) });

export function invoiceStatus(status: string): StatusView {
	switch (status) {
		case 'paid':
			return view('success', 'status.invoice.paid');
		case 'expired':
			return view('muted', 'status.invoice.expired');
		case 'failed':
			return view('danger', 'status.invoice.failed');
		case 'cancelled':
			return view('muted', 'status.invoice.cancelled');
		default:
			return view('pending', 'status.invoice.pending');
	}
}

export function subscriptionStatus(status: string): StatusView {
	switch (status) {
		case 'active':
			return view('success', 'status.subscription.active');
		case 'past_due':
			return view('warning', 'status.subscription.past_due');
		case 'cancelled':
			return view('muted', 'status.subscription.cancelled');
		case 'failed':
			return view('danger', 'status.subscription.failed');
		default:
			return view('pending', 'status.subscription.pending');
	}
}

export function chargeStatus(status: string): StatusView {
	switch (status) {
		case 'succeeded':
			return view('success', 'status.charge.succeeded');
		case 'failed':
			return view('danger', 'status.charge.failed');
		case 'reversed':
			return view('muted', 'status.charge.reversed');
		default:
			return view('info', 'status.charge.pending');
	}
}

export function cardStatus(status: string): StatusView {
	switch (status) {
		case 'active':
			return view('success', 'status.card.active');
		case 'failed':
			return view('danger', 'status.card.failed');
		case 'removed':
			return view('muted', 'status.card.removed');
		default:
			return view('pending', 'status.card.pending');
	}
}

/**
 * A delivery's display state. The table keeps `pending | succeeded | failed`;
 * a pending delivery that has been tried is "retrying". A delivery settled
 * without a request because the project has no webhook URL is "not sent".
 */
export type DeliveryState = 'queued' | 'retrying' | 'succeeded' | 'failed' | 'skipped';

export function deliveryState(d: { status: string; attempts: number; lastError: string | null }): DeliveryState {
	if (d.lastError === 'no_webhook_url' && d.status !== 'succeeded') return 'skipped';
	if (d.status === 'succeeded') return 'succeeded';
	if (d.status === 'failed') return 'failed';
	return d.attempts > 0 ? 'retrying' : 'queued';
}

export function deliveryStatus(state: DeliveryState): StatusView {
	switch (state) {
		case 'succeeded':
			return view('success', 'status.delivery.succeeded');
		case 'retrying':
			return view('warning', 'status.delivery.retrying');
		case 'failed':
			return view('danger', 'status.delivery.failed');
		case 'skipped':
			return view('muted', 'status.delivery.skipped');
		default:
			return view('pending', 'status.delivery.queued');
	}
}

export type PlanCheck = 'verified' | 'mismatch' | 'unchecked' | 'error';

export function planStatus(check: PlanCheck): StatusView {
	switch (check) {
		case 'verified':
			return view('success', 'status.plan.verified');
		case 'mismatch':
			return view('danger', 'status.plan.mismatch');
		case 'error':
			return view('warning', 'status.plan.error');
		default:
			return view('pending', 'status.plan.unchecked');
	}
}

export type ProviderState = 'configured' | 'incomplete' | 'off';

export function providerStatus(state: ProviderState): StatusView {
	if (state === 'configured') return view('success', 'status.provider.configured');
	if (state === 'incomplete') return view('warning', 'status.provider.incomplete');
	return view('muted', 'status.provider.off');
}

/** Production is the good, live state (a solid dot); sandbox is a test bench (a flask), in amber. */
export function environmentStatus(env: 'test' | 'production'): StatusView {
	return env === 'test' ? { ...view('warning', 'status.env.test'), glyph: 'flask' } : { ...view('success', 'status.env.production'), glyph: 'live' };
}

/** Event type tint (ux-brief §4): by the part after the dot. */
export function eventTypeTone(type: string): 'success' | 'danger' | 'muted' {
	const tail = type.slice(type.indexOf('.') + 1);
	if (['paid', 'succeeded', 'renewed', 'active', 'saved'].includes(tail)) return 'success';
	if (['failed', 'payment_failed'].includes(tail)) return 'danger';
	return 'muted';
}

/** `QPay`, `Bonum` */
export function providerName(provider: string): string {
	return provider === 'qpay' ? 'QPay' : provider === 'bonum' ? 'Bonum' : provider;
}

/** `month`, `year`, `week` for a plan interval. */
export function intervalUnit(interval: string): string {
	return interval === 'yearly' ? 'year' : interval === 'weekly' ? 'week' : 'month';
}
