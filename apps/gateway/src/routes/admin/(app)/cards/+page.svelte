<script lang="ts">
	import { page } from '$app/state';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Tiles from '$lib/components/Tiles.svelte';
	import Time from '$lib/components/Time.svelte';
	import Title from '$lib/components/Title.svelte';
	import { formatCardExpiry, formatCardMask, truncateEnd } from '$lib/format';
	import { cardStatus } from '$lib/status';
	import { scopedHref, withParams } from '$lib/url';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const TILES = [
		{ key: null, label: 'Saved' },
		{ key: 'active', label: 'Active' },
		{ key: 'pending', label: 'Awaiting card' },
		{ key: 'failed', label: 'Failed' },
		{ key: 'removed', label: 'Removed' }
	] as const;
	const tiles = $derived(
		TILES.map((t) => ({
			label: t.label,
			count: data.counts[t.key ?? 'all'] ?? 0,
			href: withParams(page.url, { status: t.key, before: null, after: null }),
			active: (data.filter.status ?? null) === t.key
		}))
	);
	const showProject = $derived(!data.scope);
	const caption = $derived(`Cards, newest first${data.filter.status ? `, status ${cardStatus(data.filter.status).label}` : ''}`);
</script>

<Title title="Cards" />

<PageHeader title="Cards">
	{#snippet actions()}
		<a class="btn primary" href={scopedHref('/admin/cards/new', data.scope)}>Save a card</a>
	{/snippet}
</PageHeader>

<Tiles {tiles} label="Filter by status" />

{#if data.page.rows.length === 0}
	{#if data.filter.status}
		<EmptyState title="No cards match these filters.">
			<a class="btn sm" href={withParams(page.url, { status: null, before: null, after: null })}>Clear filters</a>
		</EmptyState>
	{:else}
		<EmptyState icon="card" title="No saved cards yet">Cards appear here when a customer saves one or subscribes.</EmptyState>
	{/if}
{:else}
	<div class="table-wrap responsive">
		<table class="data">
			<caption class="sr-only">{caption}</caption>
			<thead>
				<tr>
					<th class="flex">Customer</th>
					<th>Status</th>
					<th>Card</th>
					<th class="hide-md">Bank</th>
					<th class="hide-md">Expires</th>
					{#if showProject}<th class="hide-md">Project</th>{/if}
					<th class="right">Created</th>
				</tr>
			</thead>
			<tbody>
				{#each data.page.rows as r (r.id)}
					<tr>
						<td><a class="row-link mono" href="/admin/cards/{r.id}" title={r.customerRef}>{truncateEnd(r.customerRef)}</a></td>
						<td><StatusBadge status={cardStatus(r.status)} /></td>
						<td class="mono">{#if r.mask}{formatCardMask(r.mask)}{:else}<span class="subtle">—</span>{/if}</td>
						<td class="hide-md">{r.bankName ?? '—'}</td>
						<td class="hide-md">{r.expiry ? formatCardExpiry(r.expiry) : '—'}</td>
						{#if showProject}<td class="hide-md">{r.projectName}</td>{/if}
						<td class="right muted"><Time at={r.createdAt} /></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<ul class="rows" aria-label={caption}>
		{#each data.page.rows as r (r.id)}
			<li>
				<a href="/admin/cards/{r.id}">
					<span class="line"><span class="mono">{truncateEnd(r.customerRef)}</span><StatusBadge status={cardStatus(r.status)} /></span>
					{#if r.mask}<span class="line mono">{formatCardMask(r.mask)}</span>{/if}
					<span class="line subtle"><Time at={r.createdAt} /></span>
				</a>
			</li>
		{/each}
	</ul>
	<Pager newer={data.page.newer} older={data.page.older} />
{/if}
