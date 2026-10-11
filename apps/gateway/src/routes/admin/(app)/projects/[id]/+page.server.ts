import { error, fail } from '@sveltejs/kit';
import { ApiError } from '$lib/server/api/errors';
import { rotateApiKey } from '$lib/server/auth/api-key';
import { adminContext, adminOnly, confirmed, failFrom } from '$lib/server/admin/actions';
import { isId } from '$lib/server/admin/common';
import { allowsLocalWebhooks } from '$lib/server/admin/health';
import { addChannelAction, deleteChannelAction, listChannels, testChannelAction, toggleChannelAction, updateChannelAction } from '$lib/server/admin/notify';
import {
	archiveProject,
	deliveryHealth,
	getPlan,
	getProject,
	liveSubscriptionCount,
	parsePlanInput,
	parseWebhookUrl,
	projectPlans,
	recentDeliveries,
	removePlan,
	renameProject,
	restoreProject,
	rotateWebhookSecret,
	savePlan,
	setPlanActive,
	setWebhookUrl
} from '$lib/server/admin/projects';
import { recordAudit } from '$lib/server/audit';
import { dropLogoIfUnused, dropOrphanLogos, fileFrom, logoUrl, parseDisplayName, prepareLogo, saveProjectBrand, storeLogo } from '$lib/server/branding';
import { requireConfig } from '$lib/server/locals';
import { validatePlan } from '$lib/server/providers/bonum/plans';
import type { Plan } from '$lib/server/schema';
import type { ServiceContext } from '$lib/server/services/context';
import { deliveryState } from '$lib/status';
import type { AdminIdentity } from '$lib/server/auth/admin';
import type { Actions, PageServerLoad } from './$types';

const TABS = ['general', 'key', 'webhook', 'notifications', 'plans'] as const;
type Tab = (typeof TABS)[number];

export const load: PageServerLoad = async ({ locals, params, url }) => {
	adminOnly(locals);
	const config = requireConfig(locals);
	const p = isId(params.id) ? await getProject(locals.db, params.id) : null;
	if (!p) error(404, { message: `No project with id ${params.id}`, code: 'not_found' });
	const t = url.searchParams.get('tab');
	const tab: Tab = (TABS as readonly string[]).includes(t ?? '') ? (t as Tab) : 'general';
	const [plans, live, deliveries, health, channels] = await Promise.all([
		tab === 'plans' ? projectPlans(locals.db, p.id) : Promise.resolve([]),
		tab === 'general' ? liveSubscriptionCount(locals.db, p.id) : Promise.resolve(0),
		tab === 'webhook' ? recentDeliveries(locals.db, p.id) : Promise.resolve([]),
		tab === 'webhook' ? deliveryHealth(locals.db, Date.now(), p.id) : Promise.resolve(null),
		tab === 'notifications' ? listChannels(locals.db, p.id) : Promise.resolve([])
	]);
	return {
		tab,
		project: {
			id: p.id,
			name: p.name,
			slug: p.slug,
			apiKeyPrefix: p.apiKeyPrefix,
			previousApiKeyExpiresAt: p.previousApiKeyExpiresAt,
			previousApiKeyPrefix: p.previousApiKeyPrefix,
			webhookUrl: p.webhookUrl,
			archivedAt: p.archivedAt,
			displayName: p.displayName,
			logoUrl: logoUrl(p.logoHash),
			createdAt: p.createdAt,
			updatedAt: p.updatedAt
		},
		plans,
		liveSubscriptions: live,
		deliveries: deliveries.map((r) => ({
			id: r.delivery.id,
			eventId: r.delivery.eventId,
			eventType: r.eventType,
			state: deliveryState(r.delivery),
			attempts: r.delivery.attempts,
			lastStatus: r.delivery.lastStatus,
			lastError: r.delivery.lastError,
			createdAt: r.delivery.createdAt
		})),
		health: health?.get(p.id) ?? null,
		channels,
		apiBase: `${config.publicOrigin ?? url.origin}/v1`,
		allowLocal: allowsLocalWebhooks(config),
		bonumEnvironment: config.bonum?.environment ?? null
	};
};

async function mustProject(locals: App.Locals, id: string) {
	const p = isId(id) ? await getProject(locals.db, id) : null;
	if (!p) throw new ApiError(404, 'not_found', 'Project not found');
	return p;
}

type PlanCheckResult =
	| { result: 'ok'; remote: Awaited<ReturnType<typeof validatePlan>>['remote'] }
	| { result: 'mismatch'; problems: string[]; remote: Awaited<ReturnType<typeof validatePlan>>['remote'] }
	| { result: 'error'; message: string };

/** Runs the Bonum check and records it as a `plan.validate` audit entry (its status). */
async function checkPlan(ctx: ServiceContext, admin: AdminIdentity, plan: Plan): Promise<PlanCheckResult> {
	try {
		const r = await validatePlan(ctx, plan);
		const result = r.ok ? 'ok' : 'mismatch';
		await recordAudit(ctx.db, { admin, action: 'plan.validate', subject: plan.id, detail: { result, problems: r.problems, remote: r.remote } });
		return r.ok ? { result: 'ok', remote: r.remote } : { result: 'mismatch', problems: r.problems, remote: r.remote };
	} catch (err) {
		const code = err instanceof ApiError ? err.code : 'internal_error';
		await recordAudit(ctx.db, { admin, action: 'plan.validate', subject: plan.id, detail: { result: 'error', problems: [], remote: null, error: code } });
		return { result: 'error', message: err instanceof ApiError ? err.message : 'Bonum could not be reached' };
	}
}

export const actions: Actions = {
	rename: async ({ locals, params, request }) => {
		const { admin } = adminContext(locals);
		const name = String((await request.formData()).get('name') ?? '');
		try {
			await mustProject(locals, params.id);
			await renameProject(locals.db, params.id, name);
		} catch (err) {
			return failFrom(err, 'rename');
		}
		await recordAudit(locals.db, { admin, action: 'project.rename', subject: params.id, detail: { name: name.trim() } });
		return { action: 'rename', ok: true };
	},

	/** The project's own brand on the public pay pages (display name, logo). Multipart. */
	brand: async ({ locals, params, request }) => {
		const { admin } = adminContext(locals);
		const form = await request.formData();
		let displayName: string | null = null;
		let logo: string | null | undefined;
		try {
			// Every field (the logo file included) is checked before anything is stored.
			displayName = parseDisplayName(form);
			await mustProject(locals, params.id);
			const file = fileFrom(form, 'logo');
			const prepared = file ? await prepareLogo(file) : null;
			if (prepared) logo = await storeLogo(locals.db, prepared);
			else if (form.get('removeLogo') === '1') logo = null;
			const { previousLogo } = await saveProjectBrand(locals.db, params.id, { displayName, logo });
			if (logo !== undefined && previousLogo !== logo) await dropLogoIfUnused(locals.db, previousLogo);
			await dropOrphanLogos(locals.db).catch((err) => console.error('[branding] orphan sweep failed', err instanceof Error ? err.name : typeof err));
		} catch (err) {
			const f = failFrom(err, 'brand');
			return fail(f.status, { ...f.data, displayName: String(form.get('displayName') ?? '').trim() });
		}
		await recordAudit(locals.db, {
			admin,
			action: 'project.brand',
			subject: params.id,
			detail: { displayName, logo: logo === undefined ? 'kept' : logo === null ? 'removed' : logo }
		});
		return { action: 'brand', ok: true };
	},

	webhook: async ({ locals, params, request }) => {
		const { admin, config } = adminContext(locals);
		const raw = String((await request.formData()).get('webhookUrl') ?? '');
		let url: string | null;
		try {
			await mustProject(locals, params.id);
			url = parseWebhookUrl(raw, allowsLocalWebhooks(config));
			await setWebhookUrl(locals.db, params.id, url);
		} catch (err) {
			const f = failFrom(err, 'webhook');
			return fail(f.status, { ...f.data, webhookUrl: raw });
		}
		await recordAudit(locals.db, { admin, action: 'project.webhook', subject: params.id, detail: { url } });
		return { action: 'webhook', ok: true };
	},

	rotateKey: async ({ locals, params, request }) => {
		const { admin } = adminContext(locals);
		const form = await request.formData();
		try {
			const p = await mustProject(locals, params.id);
			if (!confirmed(form, p.name)) return fail(400, { error: 'Type the project name to confirm', action: 'rotateKey' });
			const r = await rotateApiKey(locals.db, p.id);
			await recordAudit(locals.db, { admin, action: 'project.rotate_key', subject: p.id, detail: { prefix: r.prefix } });
			return { action: 'rotateKey', revealed: [{ label: 'API key', env: 'BOGTS_API_KEY', value: r.key }] };
		} catch (err) {
			return failFrom(err, 'rotateKey');
		}
	},

	rotateSecret: async ({ locals, params, request }) => {
		const { admin, config } = adminContext(locals);
		const form = await request.formData();
		try {
			const p = await mustProject(locals, params.id);
			if (!confirmed(form, p.name)) return fail(400, { error: 'Type the project name to confirm', action: 'rotateSecret' });
			const secret = await rotateWebhookSecret(locals.db, config.encryptionKey, p.id);
			await recordAudit(locals.db, { admin, action: 'project.rotate_secret', subject: p.id });
			return {
				action: 'rotateSecret',
				revealed: [{ label: 'Webhook signing secret', env: 'BOGTS_WEBHOOK_SECRET', value: secret }]
			};
		} catch (err) {
			return failFrom(err, 'rotateSecret');
		}
	},

	archive: async ({ locals, params, request }) => {
		const { admin } = adminContext(locals);
		const form = await request.formData();
		try {
			const p = await mustProject(locals, params.id);
			if (!confirmed(form, p.name)) return fail(400, { error: 'Type the project name to confirm', action: 'archive' });
			await archiveProject(locals.db, p.id);
		} catch (err) {
			return failFrom(err, 'archive');
		}
		await recordAudit(locals.db, { admin, action: 'project.archive', subject: params.id });
		return { action: 'archive', ok: true };
	},

	restore: async ({ locals, params }) => {
		const { admin } = adminContext(locals);
		try {
			await mustProject(locals, params.id);
			await restoreProject(locals.db, params.id);
		} catch (err) {
			return failFrom(err, 'restore');
		}
		await recordAudit(locals.db, { admin, action: 'project.restore', subject: params.id });
		return { action: 'restore', ok: true };
	},

	savePlan: async ({ locals, params, request }) => {
		const { admin, ctx } = adminContext(locals);
		const form = await request.formData();
		const planId = String(form.get('planId') ?? '') || null;
		let plan: Plan;
		try {
			await mustProject(locals, params.id);
			if (planId && !isId(planId)) throw new ApiError(404, 'not_found', 'Plan not found');
			plan = await savePlan(locals.db, params.id, parsePlanInput(form), planId);
		} catch (err) {
			return failFrom(err, 'savePlan');
		}
		await recordAudit(locals.db, { admin, action: 'plan.save', subject: plan.id, detail: { key: plan.key, providerPlanId: plan.providerPlanId, amount: plan.amount, interval: plan.interval } });
		const check = await checkPlan(ctx, admin, plan);
		return { action: 'savePlan', plan: { id: plan.id, key: plan.key, providerPlanId: plan.providerPlanId, amount: plan.amount, interval: plan.interval }, check };
	},

	checkPlan: async ({ locals, params, request }) => {
		const { admin, ctx } = adminContext(locals);
		const planId = String((await request.formData()).get('planId') ?? '');
		const plan = isId(planId) ? await getPlan(locals.db, params.id, planId) : null;
		if (!plan) return fail(404, { error: 'Plan not found', action: 'checkPlan' });
		const check = await checkPlan(ctx, admin, plan);
		return { action: 'checkPlan', plan: { id: plan.id, key: plan.key }, check };
	},

	togglePlan: async ({ locals, params, request }) => {
		const { admin } = adminContext(locals);
		const form = await request.formData();
		const planId = String(form.get('planId') ?? '');
		const active = form.get('active') === 'true';
		const plan = isId(planId) ? await getPlan(locals.db, params.id, planId) : null;
		if (!plan) return fail(404, { error: 'Plan not found', action: 'togglePlan' });
		await setPlanActive(locals.db, params.id, planId, active);
		await recordAudit(locals.db, { admin, action: active ? 'plan.activate' : 'plan.deactivate', subject: planId });
		return { action: 'togglePlan', ok: true };
	},

	deletePlan: async ({ locals, params, request }) => {
		const { admin } = adminContext(locals);
		const planId = String((await request.formData()).get('planId') ?? '');
		const plan = isId(planId) ? await getPlan(locals.db, params.id, planId) : null;
		if (!plan) return fail(404, { error: 'Plan not found', action: 'deletePlan' });
		const outcome = await removePlan(locals.db, params.id, planId);
		await recordAudit(locals.db, { admin, action: outcome === 'deleted' ? 'plan.delete' : 'plan.deactivate', subject: planId, detail: { key: plan.key } });
		return { action: 'deletePlan', outcome };
	},

	/* This project's notification channels. */
	addChannel: (event) => addChannelAction(event, event.params.id),
	updateChannel: (event) => updateChannelAction(event, event.params.id),
	toggleChannel: (event) => toggleChannelAction(event, event.params.id),
	testChannel: (event) => testChannelAction(event, event.params.id),
	deleteChannel: (event) => deleteChannelAction(event, event.params.id)
};
