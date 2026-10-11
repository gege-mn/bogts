import { fail } from '@sveltejs/kit';
import { adminContext, adminOnly, failFrom } from '$lib/server/admin/actions';
import { recordAudit } from '$lib/server/audit';
import { dropLogoIfUnused, dropOrphanLogos, fileFrom, parseBrandInput, prepareLogo, saveBranding, storeLogo } from '$lib/server/branding';
import { allowsLocalWebhooks, callbackUrls, cronStatus, providerHealth } from '$lib/server/admin/health';
import {
	addChannelAction,
	deleteChannelAction,
	listChannels,
	telegramChatsAction,
	testChannelAction,
	toggleChannelAction,
	updateChannelAction
} from '$lib/server/admin/notify';
import { THEME_COOKIE } from '$lib/server/admin/prefs';
import { requireConfig } from '$lib/server/locals';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	adminOnly(locals);
	const config = requireConfig(locals);
	return {
		providers: providerHealth(locals.env, config),
		callbacks: callbackUrls(config),
		warnings: config.warnings,
		security: {
			mode: config.admin.mode,
			accessTeam: config.admin.mode === 'access' ? config.admin.access.teamDomain : null,
			// loadConfig refuses to run without a valid key, so reaching here means it is valid.
			encryptionKey: true,
			adminPassword: config.admin.mode === 'password'
		},
		cron: await cronStatus(locals.db),
		channels: await listChannels(locals.db, null),
		allowLocal: allowsLocalWebhooks(config)
	};
};

export const actions: Actions = {
	/** Company branding: name, logo, accent, support contacts. Multipart (the logo file). */
	branding: async ({ locals, request }) => {
		const { admin } = adminContext(locals);
		const form = await request.formData();
		const echo = {
			companyName: String(form.get('companyName') ?? ''),
			accentColor: String(form.get('accentColor') ?? ''),
			supportEmail: String(form.get('supportEmail') ?? ''),
			supportUrl: String(form.get('supportUrl') ?? '')
		};
		let logo: string | null | undefined;
		let input: ReturnType<typeof parseBrandInput>;
		try {
			// Every field (the logo file included) is checked before anything is stored.
			input = parseBrandInput(form);
			const file = fileFrom(form, 'logo');
			const prepared = file ? await prepareLogo(file) : null;
			if (prepared) logo = await storeLogo(locals.db, prepared);
			else if (form.get('removeLogo') === '1') logo = null;
			const { previousLogo } = await saveBranding(locals.db, input, logo);
			if (logo !== undefined && previousLogo !== logo) await dropLogoIfUnused(locals.db, previousLogo);
			await dropOrphanLogos(locals.db).catch((err) => console.error('[branding] orphan sweep failed', err instanceof Error ? err.name : typeof err));
		} catch (err) {
			const f = failFrom(err, 'branding');
			return fail(f.status, { ...f.data, values: echo });
		}
		await recordAudit(locals.db, {
			admin,
			action: 'branding.update',
			detail: { ...input, logo: logo === undefined ? 'kept' : logo === null ? 'removed' : logo }
		});
		return { action: 'branding', ok: true };
	},

	/* Global notification channels: every project's payments. */
	addChannel: (event) => addChannelAction(event, null),
	updateChannel: (event) => updateChannelAction(event, null),
	toggleChannel: (event) => toggleChannelAction(event, null),
	testChannel: (event) => testChannelAction(event, null),
	deleteChannel: (event) => deleteChannelAction(event, null),
	telegramChats: telegramChatsAction,

	theme: async ({ locals, request, cookies, url }) => {
		adminContext(locals);
		const theme = String((await request.formData()).get('theme') ?? '');
		if (!['system', 'light', 'dark'].includes(theme)) return fail(400, { error: 'Pick a theme', action: 'theme' });
		const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
		if (theme === 'system') cookies.delete(THEME_COOKIE, { path: '/admin' });
		else cookies.set(THEME_COOKIE, theme, { path: '/admin', httpOnly: true, secure: !localHttp, sameSite: 'strict', maxAge: 60 * 60 * 24 * 365 });
		return { ok: true };
	}
};
