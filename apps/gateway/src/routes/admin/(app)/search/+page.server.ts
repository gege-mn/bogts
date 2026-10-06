import { adminOnly } from '$lib/server/admin/actions';
import { redirect } from '@sveltejs/kit';
import { findById, searchRefs } from '$lib/server/admin/search';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	adminOnly(locals);
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
	if (!q) return { q, results: null };
	const hit = await findById(locals.db, q);
	if (hit) redirect(303, hit);
	return { q, results: await searchRefs(locals.db, q) };
};
