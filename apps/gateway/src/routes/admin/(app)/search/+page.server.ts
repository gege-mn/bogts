import { adminOnly } from '$lib/server/admin/actions';
import { redirect } from '@sveltejs/kit';
import { SAVED_CARDS_UI } from '$lib/features';
import { findById, searchRefs } from '$lib/server/admin/search';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	adminOnly(locals);
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
	if (!q) return { q, results: null };
	const hit = await findById(locals.db, q);
	// Cards are left out while their pages are hidden.
	if (hit && (SAVED_CARDS_UI || !hit.startsWith('/admin/cards/'))) redirect(303, hit);
	const results = await searchRefs(locals.db, q);
	return { q, results: SAVED_CARDS_UI ? results : { ...results, cards: [] } };
};
