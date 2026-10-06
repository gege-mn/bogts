<script lang="ts">
	import Callout from '$lib/components/Callout.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import DeliveryBadge from '$lib/components/DeliveryBadge.svelte';
	import EventType from '$lib/components/EventType.svelte';
	import IdChip from '$lib/components/IdChip.svelte';
	import LineItems from '$lib/components/LineItems.svelte';
	import Money from '$lib/components/Money.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Time from '$lib/components/Time.svelte';
	import Timeline from '$lib/components/Timeline.svelte';
	import Title from '$lib/components/Title.svelte';
	import { formatCardExpiry, formatCardMask, formatMoney, formatShortDateTime, truncateEnd } from '$lib/format';
	import { chargeStatus } from '$lib/status';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const c = $derived(data.charge);
	let confirmReverse = $state(false);
</script>

<Title title="{formatMoney(c.amount)} charge" />

<header class="detail-head">
	<div class="eyebrow">Charge · <span class="tag">Bonum saved card</span></div>
	<div class="title-row">
		<h1><Money amount={c.amount} struck={c.status === 'reversed'} /> <span class="ccy">MNT</span></h1>
		<StatusBadge status={chargeStatus(c.status)} />
		<span class="spacer"></span>
		<CopyButton value={c.id} text="Copy id" label="Copy charge id" />
		{#if c.status === 'succeeded'}
			<button type="button" class="btn danger-text" onclick={() => (confirmReverse = true)}>Reverse charge…</button>
		{/if}
	</div>
	<p class="sub">
		<a href="/admin/projects/{data.project.id}">{data.project.name}</a> · ref
		<span class="mono">{truncateEnd(c.reference)}</span><CopyButton value={c.reference} label="Copy reference" />
	</p>
</header>

<div class="detail">
	<div class="stack">
		{#if c.status === 'reversed' && c.reversedAt}
			<Callout tone="muted">
				Reversed on {formatShortDateTime(c.reversedAt)}. {formatMoney(-c.amount)} returned to the card.
			</Callout>
		{:else if c.status === 'failed' && c.failureCode}
			<Callout tone="danger">Failed: <code>{c.failureCode}</code></Callout>
		{/if}
		{#if c.items?.length}<LineItems items={c.items} />{/if}
		<Timeline entries={data.timeline} />
		{#if data.events.length}
			<section class="card">
				<header><h2>Events</h2></header>
				<table class="data">
					<caption class="sr-only">Events emitted for this charge</caption>
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
	</div>

	<aside class="stack">
		<section class="card">
			<header><h2>Details</h2></header>
			<dl class="kv">
				<div><dt>Charge id</dt><dd><IdChip id={c.id} full /></dd></div>
				<div><dt>Bonum transaction id</dt><dd><IdChip id={c.providerTransactionId} /></dd></div>
				<div><dt>Reference</dt><dd><span class="mono">{c.reference}</span></dd></div>
				<div><dt>Created</dt><dd><Time at={c.createdAt} mode="detail" /></dd></div>
				{#if c.status !== 'pending' && c.status !== 'queued'}
					<div><dt>Settled</dt><dd><Time at={c.updatedAt} mode="detail" /></dd></div>
				{/if}
			</dl>
		</section>
		<section class="card">
			<header><h2>Card</h2></header>
			<dl class="kv">
				<div>
					<dt>Card</dt>
					<dd>
						<a class="mono" href="/admin/cards/{data.card.id}">{formatCardMask(data.card.mask)}</a>{#if data.card.bankName}&nbsp;· {data.card.bankName}{/if}{#if data.card.expiry}&nbsp;· {formatCardExpiry(data.card.expiry)}{/if}
					</dd>
				</div>
				<div><dt>Customer ref</dt><dd class="mono">{data.card.customerRef}</dd></div>
				{#if c.subscriptionId}
					<div><dt>Subscription</dt><dd><IdChip id={c.subscriptionId} href="/admin/subscriptions/{c.subscriptionId}" /></dd></div>
				{/if}
			</dl>
		</section>
		<section class="card">
			<header><h2>Project</h2></header>
			<dl class="kv">
				<div><dt>Name</dt><dd><a href="/admin/projects/{data.project.id}">{data.project.name}</a></dd></div>
			</dl>
		</section>
	</aside>
</div>

<ConfirmDialog
	bind:open={confirmReverse}
	title="Reverse charge"
	action="?/reverse"
	expected={String(c.amount)}
	confirmLabel="Reverse charge"
	cancelLabel="Keep charge"
	busyLabel="Reversing…"
	successMessage="Reversal requested"
>
	<p>
		Refunds {formatMoney(c.amount)} to <span class="mono">{formatCardMask(data.card.mask)}</span>. Can't be undone.
		{data.project.name} will receive <code>charge.reversed</code>.
	</p>
</ConfirmDialog>
