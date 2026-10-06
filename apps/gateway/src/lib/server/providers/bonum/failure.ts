/**
 * The safe machine codes in a Bonum failure webhook, as short text for the
 * activity timeline: e.g. `Bonum: ERROR, bank code 51 (insufficient funds), card`.
 *
 * Only allowlisted shapes get through: status tokens of A–Z and `_`
 * (`status`, `invoiceStatus`, `cardStatus`), a numeric `respCode` of at most
 * 3 digits, and a `paymentVendor` token. The free-text `message` (and anything
 * else) is NEVER read here, so it can never reach storage or the dashboard.
 */

/** Common ISO 8583 response codes, as short English meanings. */
export const RESPONSE_CODES: Readonly<Record<string, string>> = {
	'05': 'do not honor',
	'14': 'invalid card',
	'41': 'lost card',
	'43': 'stolen card',
	'51': 'insufficient funds',
	'54': 'expired card',
	'55': 'wrong PIN',
	'57': 'not permitted for the card',
	'58': 'not permitted for the terminal',
	'61': 'amount limit exceeded',
	'65': 'count limit exceeded',
	'91': 'issuer unavailable',
	'96': 'system error',
	'99': 'technical error'
};

/** Friendlier names for known `paymentVendor` values; others show as sent. */
const VENDORS: Readonly<Record<string, string>> = {
	E_COMMERCE: 'card',
	QPAY: 'QPay'
};

const TOKEN = /^[A-Z][A-Z_]{0,31}$/;

function token(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim().toUpperCase();
	return TOKEN.test(t) ? t : null;
}

function respCode(v: unknown): string | null {
	const s = typeof v === 'number' && Number.isInteger(v) && v >= 0 ? String(v).padStart(2, '0') : typeof v === 'string' ? v.trim() : '';
	return /^\d{1,3}$/.test(s) ? s : null;
}

export interface BonumFailure {
	/** Distinct status tokens, in the order status, invoiceStatus, cardStatus */
	statuses: string[];
	respCode: string | null;
	paymentVendor: string | null;
}

/** The allowlisted failure codes in a webhook `body`. */
export function failureCodes(body: Record<string, unknown>): BonumFailure {
	const statuses: string[] = [];
	for (const v of [body.status, body.invoiceStatus, body.cardStatus]) {
		const t = token(v);
		if (t && !statuses.includes(t)) statuses.push(t);
	}
	return { statuses, respCode: respCode(body.respCode), paymentVendor: token(body.paymentVendor) };
}

/** `bank code 51 (insufficient funds)`, or just `bank code 07` for an unknown one. */
export function describeResponseCode(code: string): string {
	const meaning = RESPONSE_CODES[code] ?? (code.length === 1 ? RESPONSE_CODES[`0${code}`] : undefined);
	return meaning ? `bank code ${code} (${meaning})` : `bank code ${code}`;
}

/** e.g. `Bonum: ERROR, bank code 51 (insufficient funds), card`; '' when the body carries no codes. */
export function describeFailure(body: Record<string, unknown>): string {
	const f = failureCodes(body);
	const parts = [...f.statuses];
	if (f.respCode) parts.push(describeResponseCode(f.respCode));
	const vendor = f.paymentVendor ? VENDORS[f.paymentVendor] : undefined;
	if (vendor) parts.push(vendor);
	return parts.length ? `Bonum: ${parts.join(', ')}` : '';
}

/** A summary sentence with the failure codes appended when there are any. */
export function withFailure(sentence: string, body: Record<string, unknown>): string {
	const detail = describeFailure(body);
	return detail ? `${sentence}. ${detail}` : sentence;
}

/**
 * A refused Purchase, for the charge's timeline: the HTTP status and the safe
 * codes of its `data`. The bank's response code is `data.respCode` when
 * present, else the digits that end the answer's `errorCode`
 * (`${invalid.bonum.response.56}`); that field is Bonum-internal, so it is
 * only shown to the operator here and never decides anything. Bonum's
 * `traceId` (hex only) and its own id of the payment follow, for asking Bonum
 * about the call.
 */
export function describePurchaseRefusal(httpStatus: number, answer: unknown, data: Record<string, unknown>): string {
	const a = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
	const tail = typeof a.errorCode === 'string' ? /\.(\d{1,3})\}?$/.exec(a.errorCode.trim())?.[1] : undefined;
	const detail = describeFailure({ ...data, respCode: respCode(data.respCode) ?? tail });
	const trace = typeof a.traceId === 'string' && /^[0-9a-f]{8,64}$/i.test(a.traceId) ? a.traceId : null;
	const paymentId = typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.id > 0 ? data.id : null;
	return `HTTP ${httpStatus}${detail ? `. ${detail}` : ''}${paymentId ? `. Bonum payment ${paymentId}` : ''}${trace ? `, trace ${trace}` : ''}`;
}
