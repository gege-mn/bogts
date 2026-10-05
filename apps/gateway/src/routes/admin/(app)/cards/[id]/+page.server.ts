import { error, redirect } from '@sveltejs/kit';
import { adminContext, adminOnly, confirmed, failFrom } from '$lib/server/admin/actions';
import { getCardDetail } from '$lib/server/admin/cards';
import { isId } from '$lib/server/admin/common';
import { getProject } from '$lib/server/admin/projects';
import { ApiError } from '$lib/server/api/errors';
import { actorOf, recordAudit } from '$lib/server/audit';
import { removeCard } from '$lib/server/services/cards';
import { createCharge } from '$lib/server/services/charges';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	adminOnly(locals);
	const detail = isId(params.id) ? await getCardDetail(locals.db, params.id) : null;
	if (!detail) error(404, { message: `No card with id ${params.id}`, code: 'not_found' });
	return detail;
};

export const actions: Actions = {
	/** Charges the card once, as `POST /v1/charges` would, and opens the charge. */
	charge: async ({ locals, params, request }) => {
		const { admin, ctx } = adminContext(locals);
		const form = await request.formData();
		const raw = String(form.get('amount') ?? '').trim();
		const reference = String(form.get('reference') ?? '').trim();
		let chargeId: string;
		try {
			const detail = await getCardDetail(locals.db, params.id);
			const project = detail ? await getProject(locals.db, detail.project.id) : null;
			if (!detail || !project) throw new ApiError(404, 'not_found', 'Card not found');
			if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new ApiError(400, 'invalid_request', 'The amount is a whole number of MNT');
			if (!reference || reference.length > 128) throw new ApiError(400, 'invalid_request', 'Enter a reference');
			const amount = Number(raw);
			const charge = await createCharge(ctx, project, { cardId: params.id, amount, reference });
			await recordAudit(locals.db, { admin, action: 'charge.create', subject: charge.id, detail: { amount, cardId: params.id } });
			chargeId = charge.id;
		} catch (err) {
			return failFrom(err, 'charge');
		}
		redirect(303, `/admin/charges/${chargeId}`);
	},
	remove: async ({ locals, params, request }) => {
		const { admin, ctx } = adminContext(locals);
		const form = await request.formData();
		const detail = await getCardDetail(locals.db, params.id);
		if (!detail) return failFrom(new ApiError(404, 'not_found', 'Card not found'), 'remove');
		if (!confirmed(form, detail.card.customerRef)) {
			return failFrom(new ApiError(400, 'invalid_request', 'Type the customer reference to confirm'), 'remove');
		}
		try {
			await removeCard(ctx, detail.project.id, params.id, actorOf(admin));
		} catch (err) {
			return failFrom(err, 'remove');
		}
		await recordAudit(locals.db, { admin, action: 'card.remove', subject: params.id });
		return { ok: true };
	}
};
