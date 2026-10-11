<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import Callout from '$lib/components/Callout.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import DeliveryBadge from '$lib/components/DeliveryBadge.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import EventType from '$lib/components/EventType.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import IdChip from '$lib/components/IdChip.svelte';
	import Money from '$lib/components/Money.svelte';
	import NotifyChannels from '$lib/components/NotifyChannels.svelte';
	import RevealSecrets from '$lib/components/RevealSecrets.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Time from '$lib/components/Time.svelte';
	import Title from '$lib/components/Title.svelte';
	import LogoField from '$lib/components/brand/LogoField.svelte';
	import BrandLogo from '$lib/components/brand/BrandLogo.svelte';
	import { formatCount, formatMoney, maskedKey } from '$lib/format';
	import { intervalUnit, planStatus } from '$lib/status';
	import { toast } from '$lib/ui.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const p = $derived(data.project);
	const archived = $derived(p.archivedAt !== null);

	const tabs = $derived(
		(
			[
				['general', 'General'],
				['key', 'API key'],
				['webhook', 'Webhook'],
				['notifications', 'Notifications'],
				['plans', 'Plans']
			] as const
		).map(([key, label]) => ({
			label,
			href: key === 'general' ? `/admin/projects/${p.id}` : `/admin/projects/${p.id}?tab=${key}`,
			active: data.tab === key
		}))
	);

	/* ---- secrets shown once ------------------------------------------- */
	type Secret = { label: string; env: string; value: string };
	let revealed = $state<Secret[]>([]);
	let revealOpen = $state(false);
	function reveal(result: Record<string, unknown> | undefined) {
		const list = result?.revealed;
		if (Array.isArray(list) && list.length) {
			revealed = list as Secret[];
			revealOpen = true;
		}
	}
	function cleared() {
		revealed = [];
	}

	let confirmRotateKey = $state(false);
	let confirmRotateSecret = $state(false);
	let confirmArchive = $state(false);

	/* ---- small forms with a toast ------------------------------------- */
	let busy = $state<string | null>(null);
	function quiet(name: string, success?: string): SubmitFunction {
		return () => {
			busy = name;
			return async ({ result, update }) => {
				busy = null;
				if (result.type === 'failure') {
					toast(typeof result.data?.error === 'string' ? result.data.error : 'Something went wrong. Try again.', 'danger');
					return;
				}
				if (result.type === 'error') {
					toast('Something went wrong. Try again.', 'danger');
					return;
				}
				if (success) toast(success);
				await update({ reset: false });
			};
		};
	}

	const curl = $derived(
		`curl ${data.apiBase}/invoices \\\n  -H "Authorization: Bearer $BOGTS_API_KEY" \\\n  -d '{"provider":"qpay","amount":1000,"reference":"test-1","description":"Test"}'`
	);

	/* ---- plans ---------------------------------------------------------- */
	type PlanDraft = { id: string | null; key: string; name: string; providerPlanId: string; amount: string; interval: string };
	let sheetOpen = $state(false);
	let draft = $state<PlanDraft>({ id: null, key: '', name: '', providerPlanId: '', amount: '', interval: 'monthly' });
	let planBusy = $state(false);
	type Check =
		| { result: 'ok'; remote: { name: string; amount: number; recurringType: string } | null }
		| { result: 'mismatch'; problems: string[]; remote: { name: string; amount: number; recurringType: string } | null }
		| { result: 'error'; message: string };
	let sheetResult = $state<{ check: Check; plan: { providerPlanId: number; amount: number; interval: string } } | null>(null);
	let sheetError = $state<string | null>(null);
	let confirmDelete = $state<{ id: string; key: string } | null>(null);
	let deleteOpen = $state(false);

	const withCommas = (digits: string) => (digits ? Number(digits).toLocaleString('en-US') : '');

	function openPlan(plan?: PageData['plans'][number]) {
		draft = plan
			? {
					id: plan.id,
					key: plan.key,
					name: plan.name,
					providerPlanId: String(plan.providerPlanId),
					amount: withCommas(String(plan.amount)),
					interval: plan.interval
				}
			: { id: null, key: '', name: '', providerPlanId: '', amount: '', interval: 'monthly' };
		sheetResult = null;
		sheetError = null;
		sheetOpen = true;
	}

	function onAmount(e: Event & { currentTarget: HTMLInputElement }) {
		const digits = e.currentTarget.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 10);
		draft.amount = withCommas(digits);
	}

	const submitPlan: SubmitFunction = () => {
		planBusy = true;
		sheetError = null;
		return async ({ result, update }) => {
			planBusy = false;
			if (result.type === 'failure') {
				sheetError = typeof result.data?.error === 'string' ? result.data.error : 'Something went wrong. Try again.';
				return;
			}
			if (result.type === 'error') {
				sheetError = 'Something went wrong. Try again.';
				return;
			}
			if (result.type === 'success' && result.data) {
				const d = result.data as { plan: { id: string; providerPlanId: number; amount: number; interval: string }; check: Check };
				draft.id = d.plan.id;
				sheetResult = { check: d.check, plan: d.plan };
				if (d.check.result === 'ok') toast('Plan saved');
			}
			await update({ reset: false });
		};
	};

	const checkQuiet: SubmitFunction = () => {
		busy = 'check';
		return async ({ result, update }) => {
			busy = null;
			if (result.type === 'success' && result.data) {
				const c = (result.data as { check: Check }).check;
				if (c.result === 'ok') toast('Matches Bonum');
				else if (c.result === 'mismatch') toast("Doesn't match Bonum", 'danger');
				else toast(c.message, 'danger');
			} else if (result.type === 'failure') toast(String(result.data?.error ?? 'Check failed'), 'danger');
			await update({ reset: false });
		};
	};

	const remoteUnit = (t: string) => (/year/i.test(t) ? 'year' : /week/i.test(t) ? 'week' : 'month');
	const webhookValue = $derived(form && 'webhookUrl' in form ? String(form.webhookUrl) : (p.webhookUrl ?? ''));
	const webhookError = $derived(form && 'error' in form && form.action === 'webhook' ? form.error : null);
	const renameError = $derived(form && 'error' in form && form.action === 'rename' ? form.error : null);
	const brandError = $derived(form && 'error' in form && form.action === 'brand' ? form.error : null);
	const displayNameValue = $derived(form && 'displayName' in form ? String(form.displayName) : (p.displayName ?? ''));
	let brandKey = $state(0);
	const saveBrand: SubmitFunction = () => {
		busy = 'brand';
		return async ({ result, update }) => {
			busy = null;
			if (result.type === 'success') {
				toast('Payment page saved');
				await update({ reset: true });
				brandKey++;
				return;
			}
			await update({ reset: false });
		};
	};
</script>

<Title title={p.name} />

<header class="detail-head">
	<div class="eyebrow">Project</div>
	<div class="title-row">
		<BrandLogo src={p.logoUrl} name={p.name} size={36} />
		<h1 class="text">{p.name}</h1>
		{#if archived}<span class="tag">Archived</span>{/if}
	</div>
</header>

<Tabs {tabs} label="Project sections" />

{#if data.tab === 'general'}
	<div class="narrow stack">
		<section class="card">
			<header><h2>General</h2></header>
			<div class="body stack">
				<form method="POST" action="?/rename" class="row-form" use:enhance={quiet('rename', 'Name saved')}>
					<div class="field grow">
						<label for="name">Name</label>
						<input id="name" name="name" class="input" value={p.name} maxlength="80" required autocomplete="off" />
						{#if renameError}<span class="error" role="alert">{renameError}</span>{/if}
					</div>
					<button type="submit" class="btn" disabled={busy === 'rename'}>{busy === 'rename' ? 'Saving…' : 'Save'}</button>
				</form>
				<dl class="kv flat">
					<div><dt>Project id</dt><dd><IdChip id={p.id} full /></dd></div>
					<div><dt>Slug</dt><dd class="mono">{p.slug}</dd></div>
					<div><dt>Created</dt><dd><Time at={p.createdAt} mode="detail" /></dd></div>
				</dl>
			</div>
		</section>

		<section class="card" aria-labelledby="brand-title">
			<header><h2 id="brand-title">Payment page</h2></header>
			{#key brandKey}
				<form method="POST" action="?/brand" enctype="multipart/form-data" class="body stack" use:enhance={saveBrand}>
					<div class="field">
						<label for="displayName">Display name</label>
						<input
							id="displayName"
							name="displayName"
							class="input"
							value={displayNameValue}
							maxlength="80"
							autocomplete="off"
							placeholder={data.brand.companyName ?? p.name}
						/>
					</div>
					<div class="field">
						<span class="label">Logo</span>
						<LogoField id="project-logo" current={p.logoUrl} name={displayNameValue || p.name} />
					</div>
					{#if brandError}<Callout tone="danger" role="alert">{brandError}</Callout>{/if}
					<div class="brand-actions">
						<span class="subtle">Empty fields use the company branding from Settings.</span>
						<button type="submit" class="btn" disabled={busy === 'brand'}>{busy === 'brand' ? 'Saving…' : 'Save'}</button>
					</div>
				</form>
			{/key}
		</section>

		<section class="card">
			<header><h2>Integration</h2></header>
			<div class="body stack">
				<div class="field">
					<span class="label">Base URL</span>
					<div class="copyrow"><code>{data.apiBase}</code><CopyButton value={data.apiBase} label="Copy base URL" /></div>
				</div>
				<div class="field">
					<span class="label">Example</span>
					<div class="code">
						<pre>{curl}</pre>
						<CopyButton value={curl} label="Copy example" />
					</div>
				</div>
			</div>
		</section>

		<section class="card danger-zone">
			<header><h2>Danger zone</h2></header>
			<div class="body zone">
				{#if archived}
					<div>
						<strong>Restore project</strong>
						<p class="muted">Its API key works again.</p>
					</div>
					<form method="POST" action="?/restore" use:enhance={quiet('restore', 'Project restored')}>
						<button type="submit" class="btn" disabled={busy === 'restore'}>Restore</button>
					</form>
				{:else}
					<div>
						<strong>Archive project</strong>
						<p class="muted">
							{#if data.liveSubscriptions > 0}
								Cancel its {formatCount(data.liveSubscriptions)} active {data.liveSubscriptions === 1 ? 'subscription' : 'subscriptions'} first.
							{:else}
								Its API key stops working. History stays.
							{/if}
						</p>
					</div>
					<button type="button" class="btn danger-text" disabled={data.liveSubscriptions > 0} onclick={() => (confirmArchive = true)}>
						Archive…
					</button>
				{/if}
			</div>
		</section>
	</div>
{:else if data.tab === 'key'}
	<div class="narrow stack">
		<section class="card">
			<header>
				<h2>API key</h2>
				<button type="button" class="btn danger-text" onclick={() => (confirmRotateKey = true)}>Rotate key…</button>
			</header>
			<dl class="kv">
				<div><dt>Key</dt><dd class="mono">{maskedKey(p.apiKeyPrefix)}</dd></div>
				<div><dt>Last changed</dt><dd><Time at={p.updatedAt} mode="detail" /></dd></div>
				{#if p.previousApiKeyExpiresAt && p.previousApiKeyExpiresAt > Date.now()}
					<div><dt>Previous key</dt><dd>Valid until <Time at={p.previousApiKeyExpiresAt} mode="detail" /></dd></div>
				{/if}
			</dl>
		</section>
	</div>
{:else if data.tab === 'webhook'}
	<div class="narrow stack">
		{#if !p.webhookUrl}
			<Callout tone="warning">Events are stored but not sent: no webhook URL.</Callout>
		{/if}
		<section class="card">
			<header><h2>Webhook URL</h2></header>
			<form method="POST" action="?/webhook" class="body row-form" use:enhance={quiet('webhook', 'Webhook URL saved')}>
				<div class="field grow">
					<label class="sr-only" for="webhookUrl">Webhook URL</label>
					<input
						id="webhookUrl"
						name="webhookUrl"
						class="input mono"
						type="url"
						inputmode="url"
						placeholder="https://example.com/webhooks/bogts"
						value={webhookValue}
						autocomplete="off"
						aria-invalid={webhookError ? 'true' : undefined}
					/>
					{#if webhookError}<span class="error" role="alert">{webhookError}</span>{:else}<span class="hint"
							>{data.allowLocal ? 'https://, or http://localhost in sandbox' : 'https:// only'}</span
						>{/if}
				</div>
				<button type="submit" class="btn" disabled={busy === 'webhook'}>{busy === 'webhook' ? 'Saving…' : 'Save'}</button>
			</form>
		</section>
		<section class="card">
			<header>
				<h2>Signing secret</h2>
				<button type="button" class="btn danger-text" onclick={() => (confirmRotateSecret = true)}>Rotate secret…</button>
			</header>
			<dl class="kv"><div><dt>Secret</dt><dd class="mono">bgwh_••••••••</dd></div></dl>
		</section>
		<section class="card">
			<header>
				<h2>Recent deliveries</h2>
				{#if data.health && data.health.failing > 0}<span class="tone-danger small">{data.health.failing} failing in 7 days</span>{/if}
			</header>
			{#if data.deliveries.length === 0}
				<p class="body subtle">No deliveries yet.</p>
			{:else}
				<table class="data">
					<caption class="sr-only">Last 10 deliveries</caption>
					<thead><tr><th>Event</th><th>Delivery</th><th class="right">Created</th></tr></thead>
					<tbody>
						{#each data.deliveries as d (d.id)}
							<tr>
								<td><a class="row-link" href="/admin/events/{d.eventId}"><EventType type={d.eventType} /></a></td>
								<td><DeliveryBadge delivery={d} detail /></td>
								<td class="right muted"><Time at={d.createdAt} /></td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>
	</div>
{:else if data.tab === 'notifications'}
	<div class="narrow stack">
		<NotifyChannels channels={data.channels} scope="project" allowLocal={data.allowLocal} />
	</div>
{:else}
	<div class="stack">
		<div class="plans-bar">
			<p class="muted small">
				{#if data.bonumEnvironment}
					Checked against <strong>Bonum {data.bonumEnvironment === 'test' ? 'sandbox' : 'production'}</strong>
				{:else}
					Bonum is off, so plans can't be checked.
				{/if}
			</p>
			<button type="button" class="btn primary" onclick={() => openPlan()}><Icon name="plus" size={14} />Add plan</button>
		</div>
		{#if data.plans.length === 0}
			<EmptyState icon="repeat" title="No plans">Add one to sell subscriptions.</EmptyState>
		{:else}
			<div class="table-wrap plans">
				<table class="data">
					<caption class="sr-only">Plans</caption>
					<thead>
						<tr>
							<th>Key</th>
							<th class="hide-md">Name</th>
							<th class="hide-md">Bonum plan</th>
							<th class="right">Amount</th>
							<th>Check</th>
							<th class="right"><span class="sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each data.plans as plan (plan.id)}
							<tr class:inactive={!plan.active}>
								<td class="mono">{plan.key}{#if !plan.active}&nbsp;<span class="tag">Inactive</span>{/if}</td>
								<td class="hide-md">{plan.name}</td>
								<td class="hide-md mono">{plan.providerPlanId}</td>
								<td class="right"><Money amount={plan.amount} /> <span class="subtle">/ {intervalUnit(plan.interval)}</span></td>
								<td title={plan.check.problems.join(', ') || undefined}><StatusBadge status={planStatus(plan.check.status)} /></td>
								<td class="right">
									<div class="row-actions">
										<button type="button" class="btn ghost sm" onclick={() => openPlan(plan)}>Edit</button>
										<form method="POST" action="?/checkPlan" use:enhance={checkQuiet}>
											<input type="hidden" name="planId" value={plan.id} />
											<button type="submit" class="btn ghost sm" disabled={busy === 'check'}>Re-check</button>
										</form>
										<form method="POST" action="?/togglePlan" use:enhance={quiet('toggle', plan.active ? 'Plan deactivated' : 'Plan activated')}>
											<input type="hidden" name="planId" value={plan.id} />
											<input type="hidden" name="active" value={plan.active ? 'false' : 'true'} />
											<button type="submit" class="btn ghost sm">{plan.active ? 'Deactivate' : 'Activate'}</button>
										</form>
										{#if plan.subscriptions === 0}
											<button
												type="button"
												class="btn ghost sm danger-text"
												onclick={() => {
													confirmDelete = { id: plan.id, key: plan.key };
													deleteOpen = true;
												}}>Delete</button
											>
										{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
{/if}

<Sheet bind:open={sheetOpen} title={draft.id ? 'Edit plan' : 'Add plan'} busy={planBusy}>
	<form id="plan-form" method="POST" action="?/savePlan" class="stack" use:enhance={submitPlan}>
		{#if draft.id}<input type="hidden" name="planId" value={draft.id} />{/if}
		<div class="field">
			<label for="plan-key">Key</label>
			<input id="plan-key" name="key" class="input mono" required pattern="[a-z0-9][a-z0-9_\-]*" bind:value={draft.key} autocomplete="off" placeholder="pro-monthly" />
		</div>
		<div class="field">
			<label for="plan-name">Name</label>
			<input id="plan-name" name="name" class="input" bind:value={draft.name} autocomplete="off" placeholder="Pro (monthly)" />
		</div>
		<div class="field">
			<label for="plan-bonum">Bonum plan id</label>
			<input id="plan-bonum" name="providerPlanId" class="input mono" inputmode="numeric" required bind:value={draft.providerPlanId} autocomplete="off" />
		</div>
		<div class="field">
			<label for="plan-amount">Amount</label>
			<div class="prefix">
				<span aria-hidden="true">₮</span>
				<input id="plan-amount" name="amount" class="input num" inputmode="numeric" required value={draft.amount} oninput={onAmount} autocomplete="off" />
			</div>
		</div>
		<div class="field">
			<label for="plan-interval">Interval</label>
			<select id="plan-interval" name="interval" class="select" bind:value={draft.interval}>
				<option value="monthly">Monthly</option>
				<option value="yearly">Yearly</option>
				<option value="weekly">Weekly</option>
			</select>
		</div>
		{#if planBusy}
			<p class="muted" role="status">Checking with Bonum…</p>
		{:else if sheetError}
			<Callout tone="danger" role="alert">{sheetError}</Callout>
		{:else if sheetResult}
			{@const c = sheetResult.check}
			{#if c.result === 'ok'}
				<Callout tone="success">
					Matches Bonum plan {sheetResult.plan.providerPlanId} ({formatMoney(sheetResult.plan.amount)} / {intervalUnit(sheetResult.plan.interval)})
				</Callout>
			{:else if c.result === 'mismatch'}
				<Callout tone="danger" role="alert">
					<p>Doesn't match Bonum plan {sheetResult.plan.providerPlanId}. New checkouts for it are blocked.</p>
					{#if c.remote}
						<table class="diff">
							<tbody>
								<tr
									><th scope="row">Amount</th><td>ours {formatMoney(sheetResult.plan.amount)}</td><td>Bonum {formatMoney(c.remote.amount)}</td></tr
								>
								<tr
									><th scope="row">Interval</th><td>ours {intervalUnit(sheetResult.plan.interval)}</td><td
										>Bonum {remoteUnit(c.remote.recurringType)}</td
									></tr
								>
							</tbody>
						</table>
					{:else if c.problems.length}
						<p>{c.problems.join(', ')}</p>
					{/if}
				</Callout>
			{:else}
				<Callout tone="warning">Saved. Check failed: {c.message}</Callout>
			{/if}
		{/if}
	</form>
	{#snippet footer()}
		<button type="button" class="btn" disabled={planBusy} onclick={() => (sheetOpen = false)}>{sheetResult ? 'Close' : 'Cancel'}</button>
		<button type="submit" form="plan-form" class="btn primary" disabled={planBusy}>{planBusy ? 'Saving…' : 'Save and check'}</button>
	{/snippet}
</Sheet>

<ConfirmDialog
	bind:open={confirmRotateKey}
	title="Rotate API key"
	action="?/rotateKey"
	expected={p.name}
	confirmLabel="Rotate key"
	cancelLabel="Keep current key"
	busyLabel="Rotating…"
	onsuccess={reveal}
>
	{#if p.previousApiKeyExpiresAt && p.previousApiKeyExpiresAt > Date.now()}
		<p>
			The older key{#if p.previousApiKeyPrefix}&nbsp;(<code>{maskedKey(p.previousApiKeyPrefix)}</code>){/if} stops working now. The current key keeps
			working for 24 h. Update the project's <code>BOGTS_API_KEY</code> before then.
		</p>
	{:else}
		<p>The current key keeps working for 24 h, then stops. Update the project's <code>BOGTS_API_KEY</code> before then.</p>
	{/if}
</ConfirmDialog>

<ConfirmDialog
	bind:open={confirmRotateSecret}
	title="Rotate signing secret"
	action="?/rotateSecret"
	expected={p.name}
	confirmLabel="Rotate secret"
	cancelLabel="Keep current secret"
	busyLabel="Rotating…"
	onsuccess={reveal}
>
	<p>Events are signed with the new secret at once. Deliveries fail verification until the project's <code>BOGTS_WEBHOOK_SECRET</code> is updated.</p>
</ConfirmDialog>

<ConfirmDialog
	bind:open={confirmArchive}
	title="Archive project"
	action="?/archive"
	expected={p.name}
	confirmLabel="Archive project"
	cancelLabel="Keep project"
	busyLabel="Archiving…"
	successMessage="Project archived"
>
	<p>Its API key stops working at once. Payments, events and history stay. You can restore it later.</p>
</ConfirmDialog>

{#if confirmDelete}
	<ConfirmDialog
		bind:open={deleteOpen}
		title="Delete plan"
		action="?/deletePlan"
		fields={{ planId: confirmDelete.id }}
		confirmLabel="Delete plan"
		cancelLabel="Keep plan"
		busyLabel="Deleting…"
		successMessage="Plan deleted"
	>
		<p>Deletes <code>{confirmDelete.key}</code>. Projects can no longer start subscriptions with it.</p>
	</ConfirmDialog>
{/if}

{#if revealed.length}
	<RevealSecrets bind:open={revealOpen} secrets={revealed} ondone={cleared} />
{/if}

<style>
	.narrow {
		max-width: 720px;
	}
	.small {
		font-size: var(--text-sm);
	}
	.row-form {
		display: flex;
		gap: var(--space-2);
		align-items: flex-end;
	}
	.row-form .grow {
		flex: 1;
		min-width: 0;
	}
	.row-form:has(.error, .hint) {
		align-items: center;
	}
	.error {
		color: var(--danger-fg);
		font-size: var(--text-sm);
	}
	.kv.flat {
		padding: 0;
	}
	.copyrow {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}
	.copyrow code {
		overflow-wrap: anywhere;
	}
	.code {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 4px;
		background: var(--bg-inset);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
	}
	.code pre {
		flex: 1;
		margin: 0;
		font: 12px/18px var(--font-mono);
		overflow-x: auto;
	}
	.danger-zone {
		border-color: var(--danger-border);
	}
	.zone {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-4);
		flex-wrap: wrap;
	}
	.zone p {
		font-size: var(--text-sm);
	}
	.plans-bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.plans {
		overflow-x: auto;
	}
	.row-actions {
		display: inline-flex;
		gap: 2px;
		justify-content: flex-end;
	}
	.row-actions form {
		display: contents;
	}
	tr.inactive td {
		color: var(--fg-muted);
	}
	.prefix {
		position: relative;
	}
	.prefix span {
		position: absolute;
		left: 12px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--fg-subtle);
	}
	.prefix .input {
		padding-left: 26px;
	}
	.diff {
		margin-top: var(--space-2);
		border-collapse: collapse;
		font-size: var(--text-sm);
	}
	.diff th,
	.diff td {
		text-align: left;
		padding: 2px var(--space-3) 2px 0;
		font-weight: var(--weight-regular);
	}
	.diff th {
		font-weight: var(--weight-medium);
	}
	table.data td {
		max-width: none;
	}
	@media (max-width: 639px) {
		.row-form {
			flex-direction: column;
			align-items: stretch;
		}
	}
	.brand-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
		font-size: var(--text-xs);
	}
</style>
