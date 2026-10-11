/**
 * Deployment health for the dashboard: which providers are on and in which
 * environment, which secret NAMES are present (never values), the callback
 * URLs to register, and the cron heartbeat.
 */
import { count, and, eq, lte } from 'drizzle-orm';
import type { DB } from '../db';
import type { Config, Env } from '../env';
import { cronHeartbeat, delivery } from '../schema';
import type { ProviderState } from '$lib/status';

export type DeploymentMode = 'production' | 'sandbox' | 'mixed' | 'none';

export type ProviderHealth = {
	id: 'bonum' | 'qpay';
	name: string;
	state: ProviderState;
	environment: 'test' | 'production';
	secrets: { name: string; present: boolean }[];
};

const SECRET_NAMES = {
	bonum: ['BONUM_APP_SECRET', 'BONUM_TERMINAL_ID', 'BONUM_CHECKSUM_KEY'],
	qpay: ['QPAY_CLIENT_ID', 'QPAY_CLIENT_PASSWORD', 'QPAY_INVOICE_CODE']
} as const;

const present = (env: Env, name: keyof Env) => {
	const v = env[name];
	return typeof v === 'string' && v.trim() !== '';
};

const envName = (raw: string | undefined): 'test' | 'production' => {
	const v = (raw ?? '').trim().toLowerCase();
	return v === 'test' || v === 'sandbox' ? 'test' : 'production';
};

export function providerHealth(env: Env, config: Config): ProviderHealth[] {
	return (['bonum', 'qpay'] as const).map((id) => {
		const names = [...SECRET_NAMES[id], 'PUBLIC_ORIGIN'] as (keyof Env)[];
		const secrets = names.map((name) => ({ name: String(name), present: present(env, name) }));
		const own = SECRET_NAMES[id].filter((n) => present(env, n)).length;
		const state: ProviderState = config.providers[id] ? 'configured' : own === 0 ? 'off' : 'incomplete';
		const environment = config[id]?.environment ?? envName(id === 'bonum' ? env.BONUM_ENVIRONMENT : env.QPAY_ENVIRONMENT);
		return { id, name: id === 'bonum' ? 'Bonum' : 'QPay', state, environment, secrets };
	});
}

/** One mode for the whole deployment, from the enabled providers' environments (ux-brief §11). */
export function deploymentMode(config: Config): { mode: DeploymentMode; sandbox: string[]; production: string[] } {
	const on = (['bonum', 'qpay'] as const).filter((p) => config[p]);
	const sandbox = on.filter((p) => config[p]!.environment === 'test').map((p) => (p === 'bonum' ? 'Bonum' : 'QPay'));
	const production = on.filter((p) => config[p]!.environment === 'production').map((p) => (p === 'bonum' ? 'Bonum' : 'QPay'));
	const mode: DeploymentMode = on.length === 0 ? 'none' : sandbox.length === 0 ? 'production' : production.length === 0 ? 'sandbox' : 'mixed';
	return { mode, sandbox, production };
}

/** True when any provider is on in sandbox (http://localhost webhooks are then allowed). */
export const allowsLocalWebhooks = (config: Config) => deploymentMode(config).mode !== 'production';

/** Something on the Settings page needs a look (the sidebar dot). */
export function settingsProblem(env: Env, config: Config): boolean {
	return config.warnings.length > 0 || providerHealth(env, config).some((p) => p.state === 'incomplete') || !config.publicOrigin;
}

export const CRON_STALE_MS = 5 * 60_000;

export async function cronStatus(db: DB, now = Date.now()) {
	const [beats, [due]] = await db.batch([
		db.select().from(cronHeartbeat),
		db
			.select({ n: count() })
			.from(delivery)
			.where(and(eq(delivery.status, 'pending'), lte(delivery.nextAttemptAt, now)))
	]);
	const byName = new Map(beats.map((b) => [b.name, b]));
	const tick = byName.get('tick') ?? null;
	return {
		tick,
		deliver: byName.get('deliver') ?? null,
		notify: byName.get('notify') ?? null,
		sweep: byName.get('sweep') ?? null,
		purge: byName.get('purge') ?? null,
		lateCheck: byName.get('late_check') ?? null,
		reconcile: byName.get('reconcile') ?? null,
		stale: !tick || now - tick.lastRunAt > CRON_STALE_MS,
		dueDeliveries: due?.n ?? 0
	};
}

/** Where to point each provider's callbacks. */
export function callbackUrls(config: Config) {
	const origin = config.publicOrigin;
	return { bonum: origin ? `${origin}/hooks/bonum` : null, origin };
}
