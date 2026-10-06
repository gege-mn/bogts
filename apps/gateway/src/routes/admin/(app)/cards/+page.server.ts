import { redirect } from '@sveltejs/kit';
import { adminOnly } from '$lib/server/admin/actions';
import { cardFilterFrom, cardsPage } from '$lib/server/admin/cards';
import { cursorFrom, isId, withScope } from '$lib/server/admin/common';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	adminOnly(locals);
	// Bonum's card page returns here with `?card=<id>` for a card started from the dashboard.
	const returned = url.searchParams.get('card');
	if (isId(returned)) redirect(303, `/admin/cards/${returned}`);
	return withScope(locals, url, async (scope) => {
		const filter = cardFilterFrom(url, scope);
		return { ...(await cardsPage(locals.db, filter, cursorFrom(url))), filter };
	});
};
