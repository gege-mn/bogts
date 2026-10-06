import { fail } from '@sveltejs/kit';
import { adminContext, adminOnly, failFrom } from '$lib/server/admin/actions';
import { isId } from '$lib/server/admin/common';
import { getProject } from '$lib/server/admin/projects';
import { ApiError } from '$lib/server/api/errors';
import { recordAudit } from '$lib/server/audit';
import { MAX_AMOUNT } from '$lib/server/money';
import { createCard } from '$lib/server/services/cards';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	adminOnly(locals);
	return {};
};

export const actions: Actions = {
	/**
	 * Starts a card step and returns Bonum's card page for the browser to open;
	 * Bonum sends it back to the Cards page, which opens the new card. The link is returned, not
	 * redirected to: the form is posted with fetch, which can't follow a
	 * redirect to another site (and the CSP's `form-action` forbids a plain post
	 * that ends there).
	 */
	default: async ({ locals, request, url }) => {
		const { admin, config, ctx } = adminContext(locals);
		const form = await request.formData();
		const values = {
			projectId: String(form.get('projectId') ?? ''),
			customerRef: String(form.get('customerRef') ?? '').trim(),
			amount: String(form.get('amount') ?? '').trim(),
			reference: String(form.get('reference') ?? '').trim()
		};
		try {
			const project = isId(values.projectId) ? await getProject(locals.db, values.projectId) : null;
			if (!project || project.archivedAt) throw new ApiError(400, 'invalid_request', 'Choose a project');
			if (!values.customerRef || values.customerRef.length > 128) throw new ApiError(400, 'invalid_request', 'Enter a customer ref');
			if (values.amount && !/^\d+$/.test(values.amount)) throw new ApiError(400, 'invalid_request', 'The first payment is a whole number of MNT');
			const amount = Number(values.amount || 0);
			if (amount > MAX_AMOUNT) throw new ApiError(400, 'invalid_request', `The first payment can be at most ${MAX_AMOUNT} MNT`);
			if (values.reference.length > 128) throw new ApiError(400, 'invalid_request', 'The reference can be at most 128 characters');
			const card = await createCard(ctx, project, {
				customerRef: values.customerRef,
				returnUrl: `${config.publicOrigin ?? url.origin}/admin/cards`,
				...(amount > 0 ? { payment: { amount, reference: values.reference || `admin-${Date.now()}` } } : {})
			});
			if (!card.redirectUrl) throw new ApiError(502, 'provider_error', 'Bonum returned no card page');
			await recordAudit(locals.db, {
				admin,
				action: 'card.create',
				subject: card.id,
				detail: { customerRef: values.customerRef, ...(amount > 0 ? { amount } : {}) }
			});
			return { redirectUrl: card.redirectUrl };
		} catch (err) {
			const f = failFrom(err, 'create');
			return fail(f.status, { ...f.data, ...values });
		}
	}
};
