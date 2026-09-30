/**
 * Bonum's webhook (registered in Bonum's merchant portal as `${PUBLIC_ORIGIN}/hooks/bonum`).
 *
 * Body capped at 64 KiB; `x-checksum-v2` verified on the raw text before it is
 * parsed. Anything that fails while applying it answers 503 so Bonum retries;
 * the ledger makes a retry harmless. Otherwise the answer is 200 `SUCCESS`,
 * including for messages we deliberately ignore. Logs carry no body.
 *
 * Every answer is JSON, `{ "status": <http status>, "message": "<CODE>" }`:
 * the shape of Bonum's own API answers. Bonum's sender parses the reply as
 * JSON, and a bare `SUCCESS` failed there ("Unrecognized token 'SUCCESS'" in
 * the merchant portal's webhook log, 2026-09-30) although the payment was
 * applied.
 */
import { ApiError, readBody } from '$lib/server/api/errors';
import { verifyBonumChecksum } from '$lib/server/providers/bonum/checksum';
import { handleBonumWebhook } from '$lib/server/providers/bonum/webhook';
import type { RequestHandler } from './$types';

const text = (message: string, status: number, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify({ status, message }), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
	});

export const POST: RequestHandler = async ({ request, locals }) => {
	const config = locals.config;
	if (!config?.bonum) return text('NOT_CONFIGURED', 503, { 'retry-after': '300' });

	let raw: string;
	try {
		raw = await readBody(request);
	} catch (err) {
		if (err instanceof ApiError) return text(err.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_BODY', err.status);
		return text('INVALID_BODY', 400);
	}
	if (!(await verifyBonumChecksum(raw, request.headers.get('x-checksum-v2'), config.bonum.checksumKey))) {
		return text('INVALID_CHECKSUM', 401);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return text('INVALID_JSON', 400);
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return text('INVALID_PAYLOAD', 400);

	try {
		await handleBonumWebhook({ db: locals.db, config, waitUntil: locals.waitUntil }, payload);
		return text('SUCCESS', 200);
	} catch (err) {
		console.error('[bonum] webhook processing failed', err instanceof Error ? err.name : typeof err);
		return text('RETRY', 503, { 'retry-after': '60' });
	}
};
