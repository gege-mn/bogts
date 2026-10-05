import { handle, json } from '$lib/server/api/errors';
import { authenticateProject } from '$lib/server/auth/api-key';
import { requireConfig } from '$lib/server/locals';
import { getCard, removeCard } from '$lib/server/services/cards';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handle(async ({ request, locals, params }) => {
	const config = requireConfig(locals);
	const project = await authenticateProject(request, locals.db);
	return json(await getCard({ db: locals.db, config }, project.id, params.id));
});

/** `DELETE /v1/cards/:id`: drops the card's token. No body; repeating it is harmless. */
export const DELETE: RequestHandler = handle(async ({ request, locals, params }) => {
	const config = requireConfig(locals);
	const project = await authenticateProject(request, locals.db);
	const ctx = { db: locals.db, config, waitUntil: locals.waitUntil };
	return json(await removeCard(ctx, project.id, params.id));
});
