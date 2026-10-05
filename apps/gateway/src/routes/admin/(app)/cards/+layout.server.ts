import { error } from '@sveltejs/kit';
import { SAVED_CARDS_UI } from '$lib/features';
import type { LayoutServerLoad } from './$types';

/** The Cards pages don't exist while the feature is hidden. */
export const load: LayoutServerLoad = () => {
	if (!SAVED_CARDS_UI) error(404, { message: 'Not found', code: 'not_found' });
};
