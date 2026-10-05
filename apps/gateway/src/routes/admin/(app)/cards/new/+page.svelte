<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Title from '$lib/components/Title.svelte';
	import { scopedHref } from '$lib/url';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let busy = $state(false);
	const projects = $derived(data.projects.filter((p) => !p.archived));
	const selected = $derived(form?.projectId ?? data.scope ?? (projects.length === 1 ? projects[0]!.id : ''));
</script>

<Title title="Save a card" />

<div class="narrow">
	<PageHeader title="Save a card">
		Opens Bonum's card page in this browser. The card is saved for the customer on the chosen project, and the project receives
		<code>card.saved</code>.
	</PageHeader>
	<!-- A plain form post: the answer is a redirect to Bonum's page, which is another site. -->
	<form class="card form" method="POST" onsubmit={() => (busy = true)}>
		<div class="field">
			<label for="projectId">Project</label>
			<select id="projectId" name="projectId" class="select" required value={selected}>
				<option value="" disabled>Choose a project</option>
				{#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
			</select>
		</div>
		<div class="field">
			<label for="customerRef">Customer ref</label>
			<input id="customerRef" name="customerRef" class="input mono" required maxlength="128" autocomplete="off" spellcheck="false" value={form?.customerRef ?? ''} />
			<span class="hint">The project's own id for the customer.</span>
		</div>
		<div class="field">
			<label for="amount">First payment, MNT <span class="subtle">(optional)</span></label>
			<input id="amount" name="amount" class="input mono" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="0" value={form?.amount ?? ''} aria-describedby="amount-hint" />
			<span class="hint" id="amount-hint">Charged to the card while it is saved. Left empty, Bonum only checks the card with 0.01 MNT.</span>
		</div>
		<div class="field">
			<label for="reference">Payment reference <span class="subtle">(optional)</span></label>
			<input id="reference" name="reference" class="input mono" maxlength="128" autocomplete="off" spellcheck="false" value={form?.reference ?? ''} />
		</div>
		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
		<div class="actions">
			<a class="btn" href={scopedHref('/admin/cards', data.scope)}>Cancel</a>
			<button type="submit" class="btn primary" disabled={busy}>{busy ? 'Opening Bonum…' : 'Continue to Bonum'}</button>
		</div>
	</form>
</div>

<style>
	.narrow {
		max-width: 560px;
	}
	.form {
		display: grid;
		gap: var(--space-4);
		padding: var(--space-5);
	}
	.error {
		color: var(--danger-fg);
		font-size: var(--text-sm);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
