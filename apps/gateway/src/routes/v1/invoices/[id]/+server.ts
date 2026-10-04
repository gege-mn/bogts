/**
 * `GET /v1/invoices/:id`. While a QPay invoice is pending and not expired, this
 * also asks QPay (at most once per 10 s per invoice, shared with the hosted
 * page's poll), so a project that shows its own QR can poll here and is not
 * left waiting on a late or lost QPay callback.
 */
import { authenticateProject } from '$lib/server/auth/api-key';
import { handle, json } from '$lib/server/api/errors';
import { deliverFresh } from '$lib/server/events/deliver';
import { requireConfig } from '$lib/server/locals';
import { pollQpayInvoice } from '$lib/server/providers/qpay/callback';
import { getInvoice, invoiceJson } from '$lib/server/services/invoices';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handle(async ({ request, locals, params }) => {
	const config = requireConfig(locals);
	const project = await authenticateProject(request, locals.db);
	const ctx = { db: locals.db, config, waitUntil: locals.waitUntil };
	let inv = await getInvoice(ctx, project.id, params.id);
	if (await pollQpayInvoice(ctx, inv)) {
		inv = await getInvoice(ctx, project.id, params.id);
		locals.waitUntil(deliverFresh(ctx));
	}
	return json(invoiceJson(inv, config));
});
