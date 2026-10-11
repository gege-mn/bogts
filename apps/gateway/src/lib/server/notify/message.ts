/**
 * What a notification says.
 *
 * `NotificationBody` is the one description of a notification: the JSON webhook
 * channel sends it as is, and the Discord and Telegram renderers turn it into a
 * message. Bodies are built when a notification is sent, from the ledger row it
 * points at, so they always describe the payment as recorded.
 *
 * Reachable from the cron, so no `$lib` imports.
 */
import { eq, inArray } from 'drizzle-orm';
import type { DB } from '../db';
import type { Config } from '../env';
import { formatMnt } from '../money';
import { card, charge, invoice, ledger, plan, project, subscription, type LedgerKind, type NotificationType, type Provider } from '../schema';

export interface PaymentReceivedData {
	ledgerId: string;
	/** What was paid: a one-off invoice, a subscription period or a charge of a saved card */
	kind: LedgerKind;
	provider: Provider;
	/** Integer MNT */
	amount: number;
	currency: 'MNT';
	/** The invoice, subscription or charge id */
	subjectId: string;
	/** The project's own reference (invoices and charges) */
	reference?: string;
	/** Invoices: the description the payer saw */
	description?: string;
	/** Subscriptions and card charges: the project's own customer id */
	customerRef?: string;
	/** Subscriptions: the plan key */
	plan?: string;
	/** True when the provider is connected in its sandbox: not real money */
	sandbox: boolean;
	/** The payment in the dashboard; null when PUBLIC_ORIGIN is not set */
	dashboardUrl: string | null;
}

export interface NotificationBody {
	/** The notification's id; the same on every retry */
	id: string;
	object: 'notification';
	type: NotificationType;
	/** ISO-8601 UTC: when the payment was recorded */
	createdAt: string;
	/** Present (true) only on a message sent with the dashboard's Send test */
	test?: true;
	/** The deployment that sent it (its PUBLIC_ORIGIN), to tell staging from production */
	origin: string | null;
	project: { id: string; name: string; slug: string };
	data: PaymentReceivedData;
}

const DASHBOARD_PATHS: Record<LedgerKind, string> = {
	invoice: '/admin/payments/',
	subscription: '/admin/subscriptions/',
	charge: '/admin/charges/'
};

const dashboardUrl = (config: Config, kind: LedgerKind, subjectId: string): string | null =>
	config.publicOrigin ? `${config.publicOrigin}${DASHBOARD_PATHS[kind]}${subjectId}` : null;

const isSandbox = (config: Config, provider: Provider): boolean => config[provider]?.environment === 'test';

/** D1 takes at most 100 bound parameters per statement. */
const IN_CHUNK = 90;

async function byId<T extends { id: string }>(ids: string[], load: (chunk: string[]) => Promise<T[]>): Promise<Map<string, T>> {
	const out = new Map<string, T>();
	for (let i = 0; i < ids.length; i += IN_CHUNK) {
		for (const row of await load(ids.slice(i, i + IN_CHUNK))) out.set(row.id, row);
	}
	return out;
}

/**
 * The `payment.received` data of ledger rows, with the project each belongs
 * to, keyed by ledger id. An id with no row is left out.
 */
export async function paymentsReceived(
	db: DB,
	config: Config,
	ledgerIds: string[]
): Promise<Map<string, { createdAt: number; project: NotificationBody['project']; data: PaymentReceivedData }>> {
	const unique = [...new Set(ledgerIds)];
	const rows = await byId(unique, (chunk) =>
		db
			.select({
				id: ledger.id,
				kind: ledger.kind,
				provider: ledger.provider,
				amount: ledger.amount,
				subjectId: ledger.subjectId,
				createdAt: ledger.createdAt,
				projectId: project.id,
				projectName: project.name,
				projectSlug: project.slug
			})
			.from(ledger)
			.innerJoin(project, eq(project.id, ledger.projectId))
			.where(inArray(ledger.id, chunk))
	);
	const subjects = (kind: LedgerKind) => [...new Set([...rows.values()].filter((r) => r.kind === kind).map((r) => r.subjectId))];
	const [invoices, subscriptions, charges] = await Promise.all([
		byId(subjects('invoice'), (chunk) =>
			db.select({ id: invoice.id, reference: invoice.reference, description: invoice.description }).from(invoice).where(inArray(invoice.id, chunk))
		),
		byId(subjects('subscription'), (chunk) =>
			db
				.select({ id: subscription.id, customerRef: subscription.customerRef, plan: plan.key })
				.from(subscription)
				.innerJoin(plan, eq(plan.id, subscription.planId))
				.where(inArray(subscription.id, chunk))
		),
		byId(subjects('charge'), (chunk) =>
			db
				.select({ id: charge.id, reference: charge.reference, customerRef: card.customerRef })
				.from(charge)
				.innerJoin(card, eq(card.id, charge.cardId))
				.where(inArray(charge.id, chunk))
		)
	]);

	const out = new Map<string, { createdAt: number; project: NotificationBody['project']; data: PaymentReceivedData }>();
	for (const r of rows.values()) {
		const inv = r.kind === 'invoice' ? invoices.get(r.subjectId) : undefined;
		const sub = r.kind === 'subscription' ? subscriptions.get(r.subjectId) : undefined;
		const chg = r.kind === 'charge' ? charges.get(r.subjectId) : undefined;
		const reference = inv?.reference ?? chg?.reference;
		const customerRef = sub?.customerRef ?? chg?.customerRef;
		out.set(r.id, {
			createdAt: r.createdAt,
			project: { id: r.projectId, name: r.projectName, slug: r.projectSlug },
			data: {
				ledgerId: r.id,
				kind: r.kind,
				provider: r.provider,
				amount: r.amount,
				currency: 'MNT',
				subjectId: r.subjectId,
				...(reference ? { reference } : {}),
				...(inv?.description ? { description: inv.description } : {}),
				...(customerRef ? { customerRef } : {}),
				...(sub ? { plan: sub.plan } : {}),
				sandbox: isSandbox(config, r.provider),
				dashboardUrl: dashboardUrl(config, r.kind, r.subjectId)
			}
		});
	}
	return out;
}

/** A made-up payment for the dashboard's Send test: marked `test`, linked to nothing. */
export function testBody(config: Config, id: string, p: NotificationBody['project'] | null, now: number): NotificationBody {
	return {
		id,
		object: 'notification',
		type: 'payment.received',
		createdAt: new Date(now).toISOString(),
		test: true,
		origin: config.publicOrigin,
		project: p ?? { id: 'test', name: 'Example project', slug: 'example' },
		data: {
			ledgerId: 'test',
			kind: 'invoice',
			provider: 'qpay',
			amount: 10_000,
			currency: 'MNT',
			subjectId: 'test',
			reference: 'order-42',
			description: 'A test notification',
			sandbox: false,
			dashboardUrl: null
		}
	};
}

/* ------------------------------------------------------------------ *
 * Rendering for people
 * ------------------------------------------------------------------ */

const KIND_TEXT: Record<LedgerKind, string> = {
	invoice: 'Invoice',
	subscription: 'Subscription payment',
	charge: 'Card charge'
};
const PROVIDER_TEXT: Record<Provider, string> = { bonum: 'Bonum', qpay: 'QPay' };

/** Text a project or a payer wrote, cut to a length that fits any channel. */
const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The parts every renderer shows, already in words. */
export function messageParts(body: NotificationBody) {
	const d = body.data;
	const marks = [body.test ? 'Test' : null, d.sandbox ? 'Sandbox' : null].filter(Boolean);
	const fields: { name: string; value: string }[] = [];
	// A blank value is left out: Discord refuses an embed field with nothing in it.
	const field = (name: string, value: string | undefined) => {
		const text = value?.trim();
		if (text) fields.push({ name, value: clip(text) });
	};
	field('Reference', d.reference);
	field('Customer', d.customerRef);
	field('Plan', d.plan);
	field('Description', d.description);
	let host: string | null = null;
	try {
		host = body.origin ? new URL(body.origin).host : null;
	} catch {
		host = null;
	}
	return {
		title: `${marks.length ? `[${marks.join(', ')}] ` : ''}${formatMnt(d.amount)} received`,
		project: clip(body.project.name, 80),
		summary: `${KIND_TEXT[d.kind]} · ${PROVIDER_TEXT[d.provider]}`,
		fields,
		url: d.dashboardUrl,
		host
	};
}

/** Backslash-escapes Discord markdown, so a reference like `order_1_a` shows as written. */
export const escapeDiscord = (text: string) => text.replace(/[\\*_~`|>[\]()#-]/g, '\\$&');

const DISCORD_GREEN = 0x2f9e6b;
const DISCORD_GREY = 0x8a8f98;

/** The Discord webhook body: one embed, and no mentions whatever the text says. */
export function discordMessage(body: NotificationBody): Record<string, unknown> {
	const m = messageParts(body);
	return {
		embeds: [
			{
				title: m.title,
				...(m.url ? { url: m.url } : {}),
				description: `**${escapeDiscord(m.project)}** · ${m.summary}`,
				color: body.test || body.data.sandbox ? DISCORD_GREY : DISCORD_GREEN,
				fields: m.fields.map((f) => ({ name: f.name, value: escapeDiscord(f.value), inline: f.name !== 'Description' })),
				...(m.host ? { footer: { text: m.host } } : {}),
				timestamp: body.createdAt
			}
		],
		allowed_mentions: { parse: [] }
	};
}

export const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The Telegram message text, in Telegram's HTML subset. */
export function telegramText(body: NotificationBody): string {
	const m = messageParts(body);
	const lines = [
		`<b>${escapeHtml(m.title)}</b>`,
		`${escapeHtml(m.project)} · ${escapeHtml(m.summary)}`,
		...m.fields.map((f) => `${f.name}: ${escapeHtml(f.value)}`)
	];
	if (m.url) lines.push(`<a href="${escapeHtml(m.url)}">Open in the dashboard</a>`);
	if (m.host) lines.push(`<i>${escapeHtml(m.host)}</i>`);
	return lines.join('\n');
}
