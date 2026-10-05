<!-- The lines a payment or charge was itemized into; a negative line is a discount. -->
<script lang="ts">
	import Money from './Money.svelte';

	let {
		items,
		title = 'Items'
	}: { items: { label: string; amount: number; quantity: number }[]; title?: string } = $props();
	const total = $derived(items.reduce((sum, i) => sum + i.amount * i.quantity, 0));
</script>

<section class="card">
	<header><h2>{title}</h2></header>
	<table class="data">
		<caption class="sr-only">{title}</caption>
		<thead><tr><th class="flex">Item</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Amount</th></tr></thead>
		<tbody>
			{#each items as i, n (n)}
				<tr>
					<td>{i.label}</td>
					<td class="right muted">{i.quantity}</td>
					<td class="right muted"><Money amount={i.amount} /></td>
					<td class="right"><Money amount={i.amount * i.quantity} /></td>
				</tr>
			{/each}
		</tbody>
		<tfoot>
			<tr><td colspan="3"><strong>Total</strong></td><td class="right"><strong><Money amount={total} /></strong></td></tr>
		</tfoot>
	</table>
</section>
