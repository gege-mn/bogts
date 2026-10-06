/**
 * Line items: what a payment is for, as the project describes it. A discount
 * is a line with a negative amount. Bogts adds the lines up and stores them;
 * it never decides a price.
 */
import { z } from 'zod';
import { ApiError } from '../api/errors';
import { MAX_AMOUNT } from '../money';
import type { LineItem } from '../schema';

export const MAX_LINE_ITEMS = 50;

export const LineItemInput = z.object({
	label: z.string().trim().min(1).max(200),
	/** Integer MNT per unit; negative for a discount */
	amount: z
		.number()
		.int()
		.min(-MAX_AMOUNT)
		.max(MAX_AMOUNT)
		.refine((n) => n !== 0, 'must not be 0'),
	quantity: z.number().int().min(1).max(10_000).default(1)
});

/** The `amount` and `items` fields of a request: send one of them. */
export const priceFields = {
	amount: z.number().int().min(1).max(MAX_AMOUNT).optional(),
	items: z.array(LineItemInput).min(1).max(MAX_LINE_ITEMS).optional()
};

export const totalOf = (items: LineItem[]) => items.reduce((sum, i) => sum + i.amount * i.quantity, 0);

/**
 * What to charge: the plain `amount`, or the sum of `items`. Exactly one of
 * them must be sent, and the total must be a payable amount (discounts can't
 * take it to zero or below). `field` prefixes the error (`payment.`).
 */
export function priceOf(input: { amount?: number; items?: LineItem[] }, field = ''): { amount: number; items: LineItem[] | null } {
	if ((input.amount === undefined) === (input.items === undefined)) {
		throw new ApiError(400, 'invalid_request', `${field}amount: send either amount or items`);
	}
	if (input.items === undefined) return { amount: input.amount!, items: null };
	const amount = totalOf(input.items);
	if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
		throw new ApiError(400, 'invalid_request', `${field}items: the total must be between 1 and ${MAX_AMOUNT} MNT`);
	}
	return { amount, items: input.items };
}
