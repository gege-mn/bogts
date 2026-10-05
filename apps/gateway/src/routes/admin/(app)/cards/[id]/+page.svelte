<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import Callout from '$lib/components/Callout.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import DeliveryBadge from '$lib/components/DeliveryBadge.svelte';
	import EventType from '$lib/components/EventType.svelte';
	import IdChip from '$lib/components/IdChip.svelte';
	import LineItems from '$lib/components/LineItems.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Money from '$lib/components/Money.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Time from '$lib/components/Time.svelte';
	import Timeline from '$lib/components/Timeline.svelte';
	import Title from '$lib/components/Title.svelte';
	import { formatCardExpiry, formatCardMask, formatMoney, formatShortDateTime } from '$lib/format';
	import { cardStatus, chargeStatus } from '$lib/status';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const c = $derived(data.card);
	const billedBy = $derived(data.subscriptions[0] ?? null);
	let confirmRemove = $state(false);

	let charging = $state(false);
	let busy = $state(false);
	let chargeError = $state<string | null>(null);
	let amount = $state('');
	let reference = $state('');
	const amountOk = $derived(/^\d+$/.test(amount.trim()) && Number(amount) >= 1);

	function openCharge() {
		amount = '';
		reference = `admin-${Date.now()}`;
		chargeError = null;
		charging = true;
	}

	const submitCharge: SubmitFunction = () => {
		busy = true;
		chargeError = null;
		return async ({ result, update }) => {
			busy = false;
			if (result.type === 'failure') {
				chargeError = typeof result.data?.error === 'string' ? result.data.error : 'Something went wrong. Try again.';
				return;
			}
			if (result.type === 'error') {
				chargeError = 'Something went wrong. Try again.';
				return;
			}
			charging = false;
			await update();
		};
	};
</script>

<Title title="Card {c.customerRef}" />

<header class="detail-head">
	<div class="eyebrow">Card · <span class="tag">Bonum</span></div>
	<div class="title-row">
		<h1 class="text">
			{#if c.mask}<span class="mono">{formatCardMask(c.mask)}</span>{:else}<span class="mono">{c.customerRef}</span>{/if}
		</h1>
		<StatusBadge status={cardStatus(c.status)} />
		<span class="spacer"></span>
		<CopyButton value={c.id} text="Copy id" label="Copy card id" />
		{#if c.status === 'active'}
			<button type="button" class="btn" onclick={openCharge}>Charge…</button>
			{#if !billedBy}
				<button type="button" class="btn danger-text" onclick={() => (confirmRemove = true)}>Remove card…</button>
			{/if}
		{/if}
	</div>
	<p class="sub">
		<span class="mono">{c.customerRef}</span><CopyButton value={c.customerRef} label="Copy customer ref" /> ·
		<a href="/admin/projects/{data.project.id}">{data.project.name}</a>
	</p>
</header>

<div class="detail">
	<div class="stack">
		{#if c.status === 'pending'}
			<Callout tone="muted">
				Waiting for the customer to enter the card on Bonum's page.
				{#if c.cardPageUrl}<a href={c.cardPageUrl} target="_blank" rel="noreferrer noopener">Open Bonum's card page ↗</a>{/if}
			</Callout>
		{:else if c.status === 'failed'}
			<Callout tone="danger">The card step failed. No card was saved.</Callout>
		{:else if c.status === 'removed' && c.removedAt}
			<Callout tone="muted">Removed on {formatShortDateTime(c.removedAt)}. Its token is deleted, so it can't be charged.</Callout>
		{/if}
		{#if billedBy}
			<Callout tone="muted">
				Bonum bills this card for subscription <IdChip id={billedBy.id} href="/admin/subscriptions/{billedBy.id}" />. Cancel the
				subscription to remove the card.
			</Callout>
		{/if}

		{#if c.firstPayment?.items?.length}
			<LineItems items={c.firstPayment.items} title="First payment" />
		{/if}

		{#if data.charges.length}
			<section class="card">
				<header><h2>Charges</h2></header>
				<table class="data">
					<caption class="sr-only">Charges of this card, newest first</caption>
					<thead><tr><th class="right">Amount</th><th>Status</th><th class="flex">Reference</th><th class="right">Created</th></tr></thead>
					<tbody>
						{#each data.charges as ch (ch.id)}
							<tr>
								<td class="right">
									<a class="row-link" href="/admin/charges/{ch.id}"><strong><Money amount={ch.amount} struck={ch.status === 'reversed'} /></strong></a>
								</td>
								<td><StatusBadge status={chargeStatus(ch.status)} /></td>
								<td class="mono muted" title={ch.reference}>{ch.reference}</td>
								<td class="right muted"><Time at={ch.createdAt} /></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		{/if}

		<Timeline entries={data.timeline} />

		{#if data.events.length}
			<section class="card">
				<header><h2>Events</h2></header>
				<table class="data">
					<caption class="sr-only">Events emitted for this card</caption>
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
			<header><h2>Card</h2></header>
			{#if c.mask}
				<dl class="kv">
					<div><dt>Card</dt><dd class="mono">{formatCardMask(c.mask)}</dd></div>
					{#if c.bankName}<div><dt>Bank</dt><dd>{c.bankName}</dd></div>{/if}
					{#if c.expiry}<div><dt>Expires</dt><dd>{formatCardExpiry(c.expiry)}</dd></div>{/if}
				</dl>
			{:else}
				<div class="body subtle">No card yet</div>
			{/if}
		</section>
		<section class="card">
			<header><h2>Details</h2></header>
			<dl class="kv">
				<div><dt>Card id</dt><dd><IdChip id={c.id} full /></dd></div>
				<div><dt>Customer ref</dt><dd><span class="mono">{c.customerRef}</span></dd></div>
				<div><dt>Project</dt><dd><a href="/admin/projects/{data.project.id}">{data.project.name}</a></dd></div>
				{#if c.replacesCardId}
					<div><dt>Replaces</dt><dd><IdChip id={c.replacesCardId} href="/admin/cards/{c.replacesCardId}" /></dd></div>
				{/if}
				{#if c.firstPayment}
					<div>
						<dt>First payment</dt>
						<dd><Money amount={c.firstPayment.amount} />{#if c.firstPayment.reference}&nbsp;· <span class="mono">{c.firstPayment.reference}</span>{/if}</dd>
					</div>
				{/if}
				<div><dt>Started</dt><dd><Time at={c.createdAt} mode="detail" /></dd></div>
				{#if c.savedAt && c.savedAt !== c.createdAt}<div><dt>Saved</dt><dd><Time at={c.savedAt} mode="detail" /></dd></div>{/if}
				{#if c.removedAt}<div><dt>Removed</dt><dd><Time at={c.removedAt} mode="detail" /></dd></div>{/if}
			</dl>
		</section>
	</aside>
</div>

<Modal bind:open={charging} title="Charge card" {busy} initialFocus="input[name=amount]">
	<form method="POST" action="?/charge" use:enhance={submitCharge} class="charge">
		<p class="muted">
			Charges <span class="mono">{c.mask ? formatCardMask(c.mask) : ''}</span> now. {data.project.name} will receive
			<code>charge.succeeded</code> or <code>charge.failed</code>.
		</p>
		<div class="field">
			<label for="charge-amount">Amount, MNT</label>
			<input id="charge-amount" name="amount" class="input mono" inputmode="numeric" pattern="[0-9]*" autocomplete="off" required bind:value={amount} />
		</div>
		<div class="field">
			<label for="charge-reference">Reference</label>
			<input id="charge-reference" name="reference" class="input mono" maxlength="128" autocomplete="off" spellcheck="false" required bind:value={reference} />
		</div>
		{#if chargeError}<Callout tone="danger" role="alert">{chargeError}</Callout>{/if}
		<div class="buttons">
			<button type="button" class="btn" disabled={busy} onclick={() => (charging = false)}>Cancel</button>
			<button type="submit" class="btn primary" disabled={!amountOk || !reference.trim() || busy}>
				{busy ? 'Charging…' : amountOk ? `Charge ${formatMoney(Number(amount))}` : 'Charge'}
			</button>
		</div>
	</form>
</Modal>

<ConfirmDialog
	bind:open={confirmRemove}
	title="Remove card"
	action="?/remove"
	expected={c.customerRef}
	confirmLabel="Remove card"
	cancelLabel="Keep card"
	busyLabel="Removing…"
	successMessage="Card removed"
>
	<p>
		Deletes the saved token of <span class="mono">{c.mask ? formatCardMask(c.mask) : ''}</span>, so it can't be charged again.
		{data.project.name} will receive <code>card.removed</code>. Can't be undone.
	</p>
</ConfirmDialog>

<style>
	.charge {
		display: grid;
		gap: var(--space-4);
	}
	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
</style>
