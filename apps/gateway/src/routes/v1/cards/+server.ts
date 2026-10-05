import { handle, json, parseJson, readBody } from '$lib/server/api/errors';
import { authenticateProject } from '$lib/server/auth/api-key';
import { idempotencyKey, idempotent } from '$lib/server/idempotency';
import { requireConfig } from '$lib/server/locals';
import { CardListQuery, createCard, CreateCardInput, listCards } from '$lib/server/services/cards';
import { queryOf } from '$lib/server/services/paging';
import type { RequestHandler } from './$types';

/** `POST /v1/cards`: `{ customerRef, returnUrl, payment? }` → 201 Card, `pending`, with `redirectUrl`. */
export const POST: RequestHandler = handle(async ({ request, locals, url }) => {
	const config = requireConfig(locals);
	const project = await authenticateProject(request, locals.db);
	const key = idempotencyKey(request);
	const body = await readBody(request);
	return idempotent(locals.db, { projectId: project.id, key, method: 'POST', path: url.pathname, body }, async () => {
		const input = parseJson(body, CreateCardInput);
		const ctx = { db: locals.db, config, waitUntil: locals.waitUntil };
		return json(await createCard(ctx, project, input), 201);
	});
});

/** `GET /v1/cards?limit&cursor&customerRef&status` */
export const GET: RequestHandler = handle(async ({ request, locals, url }) => {
	const config = requireConfig(locals);
	const project = await authenticateProject(request, locals.db);
	const q = CardListQuery.parse(queryOf(url));
	return json(await listCards({ db: locals.db, config }, project.id, q));
});
