/**
 * Dashboard features that are built but not shown yet.
 *
 * `SAVED_CARDS_UI`: the Cards pages (list, card page, "Save a card", charging
 * a card from the dashboard). Off until Bonum confirms that a card token with
 * no payment plan can be charged with Purchase: on production it answers
 * HTTP 400, response code 99. The `/v1/cards` API is unaffected.
 */
export const SAVED_CARDS_UI = false;
