<script lang="ts">
	import { enhance } from '$app/forms';
	import Callout from '$lib/components/Callout.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import NotifyChannels from '$lib/components/NotifyChannels.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Time from '$lib/components/Time.svelte';
	import Title from '$lib/components/Title.svelte';
	import AccentField from '$lib/components/brand/AccentField.svelte';
	import LogoField from '$lib/components/brand/LogoField.svelte';
	import { formatRelative } from '$lib/format';
	import { environmentStatus, providerStatus } from '$lib/status';
	import { clock, toast } from '$lib/ui.svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const brandError = $derived(form && 'error' in form && form.action === 'branding' ? form.error : null);
	const brandValues = $derived(
		form && 'values' in form && form.values
			? form.values
			: {
					companyName: data.brand.companyName ?? '',
					accentColor: data.brand.accent ?? '',
					supportEmail: data.brand.supportEmail ?? '',
					supportUrl: data.brand.supportUrl ?? ''
				}
	);
	let saving = $state(false);
	// Remount the logo and accent fields after a save, so they start from the saved values.
	let formKey = $state(0);
	const saveBrand: SubmitFunction = () => {
		saving = true;
		return async ({ result, update }) => {
			saving = false;
			if (result.type === 'success') {
				toast('Branding saved');
				await update({ reset: true });
				formKey++;
				return;
			}
			await update({ reset: false });
		};
	};
	const THEMES = ['system', 'light', 'dark'] as const;
	const staleFor = $derived(data.cron.tick ? formatRelative(data.cron.tick.lastRunAt, clock.now).replace(' ago', '') : null);
	/** The jobs that run less often than every minute, with when each last ran. */
	const jobRuns = $derived([
		{ label: 'Last expiry sweep', job: data.cron.sweep },
		{ label: 'Last late check', job: data.cron.lateCheck },
		{ label: 'Last reconcile', job: data.cron.reconcile }
	]);
</script>

<Title title="Settings" />

<div class="narrow">
	<PageHeader title="Settings" />

	{#each data.warnings as w (w)}
		<Callout tone="warning">{w}</Callout>
	{/each}

	<section class="card">
		<header><h2>Providers</h2></header>
		<ul class="list">
			{#each data.providers as p (p.id)}
				<li>
					<details>
						<summary>
							<span class="name">{p.name}</span>
							<StatusBadge status={providerStatus(p.state)} />
							{#if p.state !== 'off'}<StatusBadge status={environmentStatus(p.environment)} />{/if}
							<span class="chev" aria-hidden="true"><Icon name="chevronDown" size={14} /></span>
						</summary>
						<ul class="secrets">
							{#each p.secrets as s (s.name)}
								<li>
									<code>{s.name}</code>
									{#if s.present}<span class="tone-success"><Icon name="check" size={14} label="set" /></span>{:else}<span
											class="tone-danger"><Icon name="x" size={14} label="missing" /></span
										>{/if}
								</li>
							{/each}
						</ul>
						{#if p.state === 'incomplete'}
							<div class="pad">
								<Callout tone="warning"
									>{p.name} stays off until every secret above is set. Add them with <code>wrangler secret put</code> or in the Cloudflare
									dashboard, then redeploy.</Callout
								>
							</div>
						{/if}
					</details>
				</li>
			{/each}
		</ul>
	</section>

	<section class="card" aria-labelledby="branding-title">
		<header><h2 id="branding-title">Branding</h2></header>
		{#key formKey}
			<form method="POST" action="?/branding" enctype="multipart/form-data" class="body brand-form" use:enhance={saveBrand}>
				<div class="field">
					<span class="label">Logo</span>
					<LogoField current={data.brand.logoUrl} name={brandValues.companyName || null} />
				</div>
				<div class="field">
					<label for="companyName">Company name</label>
					<input id="companyName" name="companyName" class="input" value={brandValues.companyName} maxlength="80" placeholder="Bogts" autocomplete="organization" />
				</div>
				<div class="field">
					<label for="accent">Accent colour</label>
					<AccentField value={brandValues.accentColor} />
				</div>
				<div class="two">
					<div class="field">
						<label for="supportEmail">Support email</label>
						<input id="supportEmail" name="supportEmail" type="email" class="input" value={brandValues.supportEmail} placeholder="help@example.mn" autocomplete="off" />
					</div>
					<div class="field">
						<label for="supportUrl">Support URL</label>
						<input id="supportUrl" name="supportUrl" type="url" class="input" value={brandValues.supportUrl} placeholder="https://example.mn/help" autocomplete="off" />
					</div>
				</div>
				{#if brandError}<Callout tone="danger" role="alert">{brandError}</Callout>{/if}
				<div class="actions">
					<button type="submit" class="btn primary" disabled={saving}>{saving ? 'Saving…' : 'Save branding'}</button>
				</div>
			</form>
		{/key}
	</section>

	<NotifyChannels channels={data.channels} scope="global" allowLocal={data.allowLocal} />

	<section class="card">
		<header><h2>Callback URLs</h2></header>
		<dl class="kv">
			<div>
				<dt>Bonum · merchant portal → Webhook</dt>
				<dd>
					{#if data.callbacks.bonum}<code>{data.callbacks.bonum}</code> <CopyButton value={data.callbacks.bonum} label="Copy Bonum callback URL" />{:else}<span
							class="tone-warning">Set PUBLIC_ORIGIN first</span
						>{/if}
				</dd>
			</div>
			<div>
				<dt>QPay</dt>
				<dd class="muted">Set per invoice. Nothing to register.</dd>
			</div>
		</dl>
	</section>

	<section class="card">
		<header><h2>Security</h2></header>
		<dl class="kv cols">
			<div>
				<dt>Dashboard sign-in</dt>
				<dd>{data.security.mode === 'access' ? `Cloudflare Access · ${data.security.accessTeam}` : 'Admin password'}</dd>
			</div>
			<div>
				<dt>ENCRYPTION_KEY</dt>
				<dd class="tone-success"><Icon name="check" size={14} /> 32 bytes</dd>
			</div>
		</dl>
	</section>

	<section class="card">
		<header><h2>Background jobs</h2></header>
		{#if data.cron.stale}
			<div class="pad">
				<Callout tone="warning">
					{#if staleFor}Cron hasn't run for {staleFor}; check the Worker's triggers.{:else}Cron hasn't run yet; check the Worker's triggers.{/if}
				</Callout>
			</div>
		{/if}
		<dl class="kv cols">
			<div><dt>Last run</dt><dd><Time at={data.cron.tick?.lastRunAt} mode="relative" /></dd></div>
			<div><dt>Deliveries due now</dt><dd class="num">{data.cron.dueDeliveries}</dd></div>
			{#each jobRuns as { label, job } (label)}
				<div><dt>{label}</dt><dd>{#if job?.lastRunAt}<Time at={job.lastRunAt} mode="relative" />{:else}<span class="subtle">Never</span>{/if}</dd></div>
			{/each}
			{#each [data.cron.deliver, data.cron.notify, data.cron.sweep, data.cron.lateCheck, data.cron.reconcile, data.cron.purge].filter((j) => j?.lastError) as j (j!.name)}
				<div><dt>Last {j!.name} error</dt><dd class="tone-danger mono">{j!.lastError}</dd></div>
			{/each}
		</dl>
	</section>

	<section class="card">
		<header><h2>Appearance</h2></header>
		<form method="POST" action="?/theme" use:enhance class="pad theme">
			<fieldset class="seg-radio">
				<legend class="sr-only">Theme</legend>
				{#each THEMES as t (t)}
					<label>
						<input type="radio" name="theme" value={t} checked={data.theme === t} onchange={(e) => e.currentTarget.form?.requestSubmit()} />
						<span>{t[0]!.toUpperCase() + t.slice(1)}</span>
					</label>
				{/each}
			</fieldset>
			<noscript><button class="btn sm" type="submit">Save</button></noscript>
		</form>
	</section>

	<p class="about subtle">
		Bogts · Apache-2.0 · <a href="https://github.com/gege-mn/bogts#readme" rel="noreferrer noopener" target="_blank">Docs ↗</a>
	</p>
</div>

<style>
	.narrow {
		max-width: 720px;
		display: grid;
		gap: var(--space-4);
	}
	.narrow :global(.page-header) {
		margin-bottom: 0;
	}
	.list,
	.secrets {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.list > li + li {
		border-top: 1px solid var(--border);
	}
	summary {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
		padding: var(--space-3) var(--space-4);
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	/* Only the chevron turns; badge icons in the same row stay upright. */
	.chev {
		display: inline-grid;
		margin-left: auto;
		color: var(--fg-subtle);
		transition: transform var(--dur-base) var(--ease);
	}
	details[open] .chev {
		transform: rotate(180deg);
	}
	summary:hover .chev {
		color: var(--fg);
	}
	.brand-form {
		display: grid;
		gap: var(--space-5);
	}
	.two {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-4);
	}
	.actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-3);
		flex-wrap: wrap;
		padding-top: var(--space-4);
		border-top: 1px solid var(--border);
	}
	@media (max-width: 559px) {
		.two {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.name {
		font-weight: var(--weight-medium);
		min-width: 64px;
	}
	.secrets {
		padding: 0 var(--space-4) var(--space-3);
		display: grid;
		gap: var(--space-1);
	}
	.secrets li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: var(--text-sm);
	}
	.pad {
		padding: var(--space-3) var(--space-4) 0;
	}
	.theme {
		padding-bottom: var(--space-4);
	}
	.kv.cols {
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		column-gap: var(--space-6);
	}
	.kv code {
		overflow-wrap: anywhere;
	}
	.seg-radio {
		display: inline-flex;
		margin: 0;
		padding: 0;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-md);
		overflow: hidden;
	}
	.seg-radio label {
		position: relative;
		cursor: pointer;
	}
	.seg-radio label + label {
		border-left: 1px solid var(--border);
	}
	.seg-radio input {
		position: absolute;
		opacity: 0;
		inset: 0;
		margin: 0;
		cursor: pointer;
	}
	.seg-radio span {
		display: block;
		padding: 0 var(--space-3);
		line-height: 30px;
		font-size: var(--text-sm);
		color: var(--fg-muted);
	}
	.seg-radio input:checked + span {
		background: var(--accent-subtle);
		color: var(--accent-text);
		font-weight: var(--weight-medium);
	}
	.seg-radio input:focus-visible + span {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}
	.about {
		font-size: var(--text-xs);
	}
</style>
