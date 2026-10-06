<script lang="ts">
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Money from '$lib/components/Money.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Time from '$lib/components/Time.svelte';
	import Title from '$lib/components/Title.svelte';
	import { formatCardMask, truncateEnd } from '$lib/format';
	import { cardStatus, chargeStatus, invoiceStatus, subscriptionStatus } from '$lib/status';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const r = $derived(data.results);
	const empty = $derived(!r || (r.invoices.length === 0 && r.charges.length === 0 && r.subscriptions.length === 0 && r.cards.length === 0));
</script>

<Title title="Search" />

<PageHeader title="Search" />

{#if empty}
	<EmptyState icon="search" title={data.q ? `Nothing matches ${data.q}` : 'Search'}>
		Search takes an exact id, reference or customer ref.
	</EmptyState>
{:else if r}
	<div class="stack">
		{#if r.invoices.length}
			<section class="card">
				<header><h2>Payments</h2></header>
				<ul class="results">
					{#each r.invoices as i (i.id)}
						<li>
							<a href="/admin/payments/{i.id}">
								<strong><Money amount={i.amount} /></strong>
								<StatusBadge status={invoiceStatus(i.status)} />
								<span class="mono ref">{truncateEnd(i.reference)}</span>
								<span class="subtle when"><Time at={i.createdAt} /></span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if r.charges.length}
			<section class="card">
				<header><h2>Charges</h2></header>
				<ul class="results">
					{#each r.charges as c (c.id)}
						<li>
							<a href="/admin/charges/{c.id}">
								<strong><Money amount={c.amount} struck={c.status === 'reversed'} /></strong>
								<StatusBadge status={chargeStatus(c.status)} />
								<span class="mono ref">{truncateEnd(c.reference)}</span>
								<span class="subtle when"><Time at={c.createdAt} /></span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if r.subscriptions.length}
			<section class="card">
				<header><h2>Subscriptions</h2></header>
				<ul class="results">
					{#each r.subscriptions as s (s.id)}
						<li>
							<a href="/admin/subscriptions/{s.id}">
								<span class="mono ref">{truncateEnd(s.customerRef)}</span>
								<StatusBadge status={subscriptionStatus(s.status)} />
								<span class="subtle when"><Time at={s.createdAt} /></span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if r.cards.length}
			<section class="card">
				<header><h2>Cards</h2></header>
				<ul class="results">
					{#each r.cards as c (c.id)}
						<li>
							<a href="/admin/cards/{c.id}">
								<span class="mono">{formatCardMask(c.mask)}</span>
								<StatusBadge status={cardStatus(c.status)} />
								<span class="mono ref">{truncateEnd(c.customerRef)}</span>
								<span class="subtle when"><Time at={c.createdAt} /></span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</div>
{/if}

<style>
	.results {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.results li + li {
		border-top: 1px solid var(--border);
	}
	.results a {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		min-height: 44px;
		padding: var(--space-2) var(--space-4);
		color: inherit;
		font-size: var(--text-sm);
	}
	.results a:hover {
		background: var(--bg-subtle);
		text-decoration: none;
	}
	.ref {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.when {
		margin-left: auto;
	}
</style>
