<script lang="ts">
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import DeliveryBadge from '$lib/components/DeliveryBadge.svelte';
	import EventType from '$lib/components/EventType.svelte';
	import IdChip from '$lib/components/IdChip.svelte';
	import JsonViewer from '$lib/components/JsonViewer.svelte';
	import LineItems from '$lib/components/LineItems.svelte';
	import Money from '$lib/components/Money.svelte';
	import ProviderTag from '$lib/components/ProviderTag.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Time from '$lib/components/Time.svelte';
	import Timeline from '$lib/components/Timeline.svelte';
	import Title from '$lib/components/Title.svelte';
	import { formatMoney, hostOf, truncateEnd } from '$lib/format';
	import { invoiceStatus } from '$lib/status';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const inv = $derived(data.invoice);
	let confirmCancel = $state(false);
	const metadata = $derived(inv.metadata && Object.keys(inv.metadata).length ? inv.metadata : null);
</script>

<Title title="{formatMoney(inv.amount)} payment" />

<header class="detail-head">
	<div class="eyebrow">Payment · <ProviderTag provider={inv.provider} /></div>
	<div class="title-row">
		<h1><Money amount={inv.amount} /> <span class="ccy">MNT</span></h1>
		<StatusBadge status={invoiceStatus(inv.status)} />
		<span class="spacer"></span>
		<CopyButton value={inv.id} text="Copy id" label="Copy payment id" />
		{#if inv.status === 'pending'}
			<button type="button" class="btn danger-text" onclick={() => (confirmCancel = true)}>Cancel…</button>
		{/if}
	</div>
	<p class="sub">
		<a href="/admin/projects/{data.project.id}">{data.project.name}</a> · ref
		<span class="mono">{truncateEnd(inv.reference)}</span><CopyButton value={inv.reference} label="Copy reference" />
		{#if inv.description}· “{inv.description}”{/if}
	</p>
</header>

<div class="detail">
	<div class="stack">
		{#if inv.items?.length}<LineItems items={inv.items} />{/if}
		<Timeline entries={data.timeline} />
		{#if data.events.length}
			<section class="card">
				<header><h2>Events</h2></header>
				<table class="data">
					<caption class="sr-only">Events emitted for this payment</caption>
					<thead><tr><th>Type</th><th>Delivery</th><th class="right">Created</th></tr></thead>
					<tbody>
						{#each data.events as e (e.id)}
							<tr>
								<td><a class="row-link" href="/admin/events/{e.id}"><EventType type={e.type} /></a></td>
								<td><DeliveryBadge delivery={e.delivery} detail /></td>
								<td class="right muted"><Time at={e.createdAt} /></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		{/if}
		{#if metadata}<JsonViewer value={metadata} title="Metadata" />{/if}
	</div>

	<aside class="stack">
		<section class="card">
			<header><h2>Details</h2></header>
			<dl class="kv">
				<div><dt>Payment id</dt><dd><IdChip id={inv.id} full /></dd></div>
				{#if inv.providerInvoiceId}<div><dt>Provider invoice id</dt><dd><IdChip id={inv.providerInvoiceId} /></dd></div>{/if}
				{#if inv.providerTransactionId}<div><dt>Provider payment ref</dt><dd><IdChip id={inv.providerTransactionId} /></dd></div>{/if}
				<div><dt>Created</dt><dd><Time at={inv.createdAt} mode="detail" /></dd></div>
				{#if inv.paidAt}
					<div><dt>Paid</dt><dd><Time at={inv.paidAt} mode="detail" /></dd></div>
				{:else}
					<div><dt>Expires</dt><dd><Time at={inv.expiresAt} mode="detail" /></dd></div>
				{/if}
				{#if inv.sweptAt}<div><dt>Expiry check</dt><dd><Time at={inv.sweptAt} mode="detail" /></dd></div>{/if}
				{#if inv.returnUrl}
					<div><dt>Return URL</dt><dd><a href={inv.returnUrl} rel="noreferrer noopener" target="_blank">{truncateEnd(inv.returnUrl, 40)}</a></dd></div>
				{/if}
			</dl>
		</section>
		{#if inv.status === 'pending' && inv.provider === 'qpay' && inv.hasQr}
			<section class="card">
				<header><h2>Checkout</h2></header>
				<div class="body"><a href="/pay/{inv.id}" target="_blank" rel="noopener">Open checkout page ↗</a></div>
			</section>
		{:else if inv.status === 'pending' && inv.redirectUrl}
			<section class="card">
				<header><h2>Checkout</h2></header>
				<div class="body"><a href={inv.redirectUrl} target="_blank" rel="noreferrer noopener">Open Bonum checkout ↗</a></div>
			</section>
		{/if}
		<section class="card">
			<header><h2>Project</h2></header>
			<dl class="kv">
				<div><dt>Name</dt><dd><a href="/admin/projects/{data.project.id}">{data.project.name}</a></dd></div>
				<div><dt>Webhook</dt><dd>{hostOf(data.project.webhookUrl) ?? 'Not set'}</dd></div>
			</dl>
		</section>
	</aside>
</div>

<ConfirmDialog
	bind:open={confirmCancel}
	title="Cancel payment"
	action="?/cancel"
	confirmLabel="Cancel payment"
	cancelLabel="Keep payment"
	busyLabel="Cancelling…"
	successMessage="Payment cancelled"
>
	<p>The payer can no longer pay this invoice. If money still arrives, it is recorded and reported.</p>
	<p>Can't be undone.</p>
</ConfirmDialog>


