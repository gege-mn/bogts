/**
 * Where Bonum sends the customer's browser after a plan-less card step. It
 * only redirects to the step's `returnUrl` with `?card=<id>`: state comes from
 * webhooks, never from this request or anything Bonum appends to it.
 */
import { eq } from 'drizzle-orm';
import { cardSetup } from '$lib/server/schema';
import type { RequestHandler } from './$types';

const notFound = () =>
	new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!/^[0-9A-Za-z]{1,64}$/.test(params.id)) return notFound();
	const [row] = await locals.db
		.select({ id: cardSetup.id, returnUrl: cardSetup.returnUrl })
		.from(cardSetup)
		.where(eq(cardSetup.id, params.id))
		.limit(1);
	if (!row) return notFound();
	let target: URL;
	try {
		target = new URL(row.returnUrl);
	} catch {
		return notFound();
	}
	target.searchParams.set('card', row.id);
	return new Response(null, { status: 303, headers: { location: target.toString(), 'cache-control': 'no-store' } });
};
