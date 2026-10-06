import { handle, json, parseJson, readBody } from '$lib/server/api/errors';
import { authenticateProject } from '$lib/server/auth/api-key';
import { idempotencyKey, idempotent } from '$lib/server/idempotency';
import { requireConfig } from '$lib/server/locals';
import { ReplaceCardInput, replaceSavedCard } from '$lib/server/services/cards';
import type { RequestHandler } from './$types';

/** `POST /v1/cards/:id/replace`: `{ returnUrl }` → 201 with the new card, `pending`, with `redirectUrl`. */
export const POST: RequestHandler = handle(async ({ request, locals, url, params }) => {
	const config = requireConfig(locals);
	const project = await authenticateProject(request, locals.db);
	const key = idempotencyKey(request);
	const body = await readBody(request);
	return idempotent(locals.db, { projectId: project.id, key, method: 'POST', path: url.pathname, body }, async () => {
		const input = parseJson(body, ReplaceCardInput);
		const ctx = { db: locals.db, config, waitUntil: locals.waitUntil };
		return json(await replaceSavedCard(ctx, project.id, params.id, input), 201);
	});
});
