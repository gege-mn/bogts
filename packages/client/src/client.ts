/**
 * The API client. Server side only: it carries a project API key.
 *
 * ```ts
 * const bogts = new Bogts({ apiKey: env.BOGTS_API_KEY, baseUrl: 'https://pay.example.com' });
 * const invoice = await bogts.invoices.create({ provider: 'qpay', amount: 10000, reference: 'order-42', description: 'Order 42' });
 * ```
 */
import { BogtsError } from './errors.js';
import type {
	BogtsErrorBody,
	BogtsEvent,
	Card,
	Charge,
	CreateCardInput,
	CreateChargeInput,
	CreateInvoiceInput,
	CreateSubscriptionInput,
	CreatedInvoice,
	EventListParams,
	Invoice,
	List,
	ListParams,
	RequestOptions,
	Subscription
} from './types.js';

export interface BogtsOptions {
	/** The project API key, `bgk_…` */
	apiKey: string;
	/** The deployment's origin, e.g. `https://pay.example.com` (with or without `/v1`) */
	baseUrl: string;
	/** A fetch implementation; defaults to the global one */
	fetch?: typeof fetch;
	/** Extra headers on every request */
	headers?: Record<string, string>;
}

type Query = Record<string, string | number | boolean | string[] | undefined>;

const enc = encodeURIComponent;

function randomUUID(): string {
	const c = (globalThis as { crypto?: Crypto }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	if (c?.getRandomValues) {
		const b = c.getRandomValues(new Uint8Array(16));
		b[6] = (b[6]! & 0x0f) | 0x40;
		b[8] = (b[8]! & 0x3f) | 0x80;
		const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
	}
	throw new BogtsError(0, 'no_crypto', 'No Web Crypto here: pass idempotencyKey explicitly');
}

export class Bogts {
	readonly baseUrl: string;
	readonly #apiKey: string;
	readonly #fetch: typeof fetch;
	readonly #headers: Record<string, string>;

	constructor(options: BogtsOptions) {
		if (!options?.apiKey) throw new TypeError('Bogts: apiKey is required');
		if (!options.baseUrl) throw new TypeError('Bogts: baseUrl is required');
		this.#apiKey = options.apiKey;
		this.baseUrl = options.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
		const f = options.fetch ?? globalThis.fetch;
		if (!f) throw new TypeError('Bogts: no fetch available; pass options.fetch');
		this.#fetch = f.bind(globalThis);
		this.#headers = options.headers ?? {};
	}

	/** Low level: one API call. Resolves with the parsed JSON, or throws `BogtsError`. */
	async request<T>(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		opts: { query?: Query; body?: unknown } & RequestOptions = {}
	): Promise<T> {
		return (await this.#send<T>(method, path, opts)).data;
	}

	/** `request`, also returning the response (for its status and headers). */
	async #send<T>(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		opts: { query?: Query; body?: unknown } & RequestOptions = {}
	): Promise<{ data: T; response: Response }> {
		const url = new URL(`${this.baseUrl}${path}`);
		for (const [k, v] of Object.entries(opts.query ?? {})) {
			if (v === undefined) continue;
			url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
		}
		const headers: Record<string, string> = {
			accept: 'application/json',
			...this.#headers,
			authorization: `Bearer ${this.#apiKey}`
		};
		if (opts.body !== undefined) headers['content-type'] = 'application/json';
		if (method === 'POST') headers['idempotency-key'] = opts.idempotencyKey ?? randomUUID();
		else if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

		let res: Response;
		try {
			res = await this.#fetch(url.toString(), {
				method,
				headers,
				body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
				signal: opts.signal
			});
		} catch (err) {
			if ((err as { name?: string })?.name === 'AbortError') throw err;
			throw new BogtsError(0, 'network_error', `Could not reach Bogts: ${(err as Error)?.message ?? String(err)}`);
		}
		const text = await res.text();
		let parsed: unknown = undefined;
		if (text) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = undefined;
			}
		}
		if (!res.ok) {
			const err = (parsed as BogtsErrorBody | undefined)?.error;
			if (err && typeof err.code === 'string') throw new BogtsError(res.status, err.code, String(err.message ?? ''));
			throw new BogtsError(res.status, 'http_error', `Bogts answered HTTP ${res.status}`);
		}
		if (parsed === undefined) throw new BogtsError(res.status, 'invalid_response', 'Bogts answered with no JSON');
		return { data: parsed as T, response: res };
	}

	readonly invoices = {
		/**
		 * A new invoice (`reused: false`), or the project's pending invoice for the
		 * same purchase handed back (`reused: true`; see `CreateInvoiceInput.reuse`).
		 */
		create: async (input: CreateInvoiceInput, opts?: RequestOptions): Promise<CreatedInvoice> => {
			const { data, response } = await this.#send<Invoice>('POST', '/v1/invoices', { ...opts, body: input });
			const header = response.headers.get('bogts-reused');
			// An older gateway sends no header: 200 means reused, 201 new.
			const reused = header === null ? response.status === 200 : header.trim().toLowerCase() === 'true';
			return { ...data, reused };
		},
		get: (id: string, opts?: RequestOptions) => this.request<Invoice>('GET', `/v1/invoices/${enc(id)}`, opts),
		list: (params: ListParams = {}, opts?: RequestOptions) =>
			this.request<List<Invoice>>('GET', '/v1/invoices', { ...opts, query: params }),
		cancel: (id: string, opts?: RequestOptions) =>
			this.request<Invoice>('POST', `/v1/invoices/${enc(id)}/cancel`, opts)
	};

	readonly subscriptions = {
		create: (input: CreateSubscriptionInput, opts?: RequestOptions) =>
			this.request<Subscription>('POST', '/v1/subscriptions', { ...opts, body: input }),
		get: (id: string, opts?: RequestOptions) =>
			this.request<Subscription>('GET', `/v1/subscriptions/${enc(id)}`, opts),
		list: (params: ListParams = {}, opts?: RequestOptions) =>
			this.request<List<Subscription>>('GET', '/v1/subscriptions', { ...opts, query: params }),
		/** Cancels the mandate at Bonum. `DELETE /v1/subscriptions/:id` */
		cancel: (id: string, opts?: RequestOptions) =>
			this.request<Subscription>('DELETE', `/v1/subscriptions/${enc(id)}`, opts),
		/** Starts a card replacement; send the customer to the returned `redirectUrl`. */
		replaceCard: (id: string, opts?: RequestOptions) =>
			this.request<Subscription>('POST', `/v1/subscriptions/${enc(id)}/card`, opts)
	};

	readonly cards = {
		/** Starts a card step; send the customer to the returned `redirectUrl`. The card is saved on `card.saved`. */
		create: (input: CreateCardInput, opts?: RequestOptions) =>
			this.request<Card>('POST', '/v1/cards', { ...opts, body: input }),
		get: (id: string, opts?: RequestOptions) => this.request<Card>('GET', `/v1/cards/${enc(id)}`, opts),
		list: (params: ListParams = {}, opts?: RequestOptions) =>
			this.request<List<Card>>('GET', '/v1/cards', { ...opts, query: params }),
		/** Starts a card step for a new card (a new id); the old card is removed once the new one is saved. */
		replace: (id: string, input: { returnUrl: string }, opts?: RequestOptions) =>
			this.request<Card>('POST', `/v1/cards/${enc(id)}/replace`, { ...opts, body: input }),
		/** Drops the card's token. `DELETE /v1/cards/:id` */
		remove: (id: string, opts?: RequestOptions) => this.request<Card>('DELETE', `/v1/cards/${enc(id)}`, opts)
	};

	readonly charges = {
		create: (input: CreateChargeInput, opts?: RequestOptions) =>
			this.request<Charge>('POST', '/v1/charges', { ...opts, body: input }),
		get: (id: string, opts?: RequestOptions) => this.request<Charge>('GET', `/v1/charges/${enc(id)}`, opts),
		list: (params: ListParams = {}, opts?: RequestOptions) =>
			this.request<List<Charge>>('GET', '/v1/charges', { ...opts, query: params }),
		reverse: (id: string, opts?: RequestOptions) =>
			this.request<Charge>('POST', `/v1/charges/${enc(id)}/reverse`, opts)
	};

	readonly events = {
		get: (id: string, opts?: RequestOptions) => this.request<BogtsEvent>('GET', `/v1/events/${enc(id)}`, opts),
		/** Newest first by default (`cursor`), or oldest first after an id (`after`). */
		list: (params: EventListParams = {}, opts?: RequestOptions) =>
			this.request<List<BogtsEvent>>('GET', '/v1/events', { ...opts, query: { ...params } }),
		/**
		 * Every event after `after` (or from the beginning), oldest first, page by
		 * page. Stops at the end of the feed; save the last id you processed and
		 * start from it next time.
		 *
		 * ```ts
		 * for await (const event of bogts.events.iterate({ after: lastSeenId })) { … }
		 * ```
		 */
		iterate: (params: Omit<EventListParams, 'cursor'> = {}, opts?: RequestOptions): AsyncIterable<BogtsEvent> => {
			const list = this.events.list;
			return {
				async *[Symbol.asyncIterator]() {
					let after = params.after;
					for (;;) {
						// An empty `after` is the start of the feed, oldest first.
						const page = await list({ ...params, after: after ?? '' }, opts);
						for (const event of page.data) {
							yield event;
							after = event.id;
						}
						if (!page.hasMore || page.data.length === 0) return;
					}
				}
			};
		}
	};
}
