<!--
	Secrets shown once (ux-brief §9.1). The only way out is Done, which stays
	disabled until "I've saved these" is ticked; Esc, ✕ and the backdrop do
	nothing until then. The values come from an action result, never from
	page data, so a reload shows only the masked values.
-->
<script lang="ts">
	import { copyText } from '$lib/ui.svelte';
	import Callout from './Callout.svelte';
	import CopyButton from './CopyButton.svelte';
	import Modal from './Modal.svelte';

	type Secret = { label: string; env: string; value: string };
	let {
		open = $bindable(false),
		secrets,
		note,
		lost = 'If lost, rotate to get new ones.',
		ondone
	}: { open?: boolean; secrets: Secret[]; note?: string; lost?: string; ondone?: () => void } = $props();

	let saved = $state(false);

	function finish() {
		// The dialog can only close once "saved" is ticked.
		if (!saved) return;
		saved = false;
		ondone?.();
	}

	const envText = $derived(secrets.map((s) => `${s.env}=${s.value}`).join('\n'));
	let envCopied = $state(false);
	async function copyEnv() {
		if (await copyText(envText)) {
			envCopied = true;
			setTimeout(() => (envCopied = false), 1500);
		}
	}
</script>

<Modal bind:open title={secrets.length > 1 ? 'Save these secrets now' : 'Save this secret now'} dismissible={saved} onclose={finish}>
	<Callout tone="warning">You won't see {secrets.length > 1 ? 'them' : 'it'} again. {lost}</Callout>
	{#each secrets as s (s.env)}
		<div class="field">
			<label for="secret-{s.env}">{s.label}</label>
			<div class="row">
				<input
					id="secret-{s.env}"
					class="input mono"
					readonly
					value={s.value}
					onfocus={(e) => e.currentTarget.select()}
				/>
				<CopyButton value={s.value} text="Copy" label="Copy {s.label}" />
			</div>
		</div>
	{/each}
	<div class="env">
		<span class="muted">{note ?? `Set as ${secrets.map((s) => s.env).join(' and ')}.`}</span>
		<button type="button" class="btn sm" onclick={copyEnv}>{envCopied ? 'Copied' : 'Copy as .env'}</button>
	</div>
	<label class="check">
		<input type="checkbox" bind:checked={saved} />
		I've saved {secrets.length > 1 ? 'these' : 'this'} somewhere safe
	</label>
	{#snippet footer()}
		<button type="button" class="btn primary" disabled={!saved} onclick={() => (open = false)}>Done</button>
	{/snippet}
</Modal>

<style>
	.row {
		display: flex;
		gap: var(--space-2);
	}
	.env {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
		font-size: var(--text-sm);
	}
	.check {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		min-height: 32px;
		cursor: pointer;
	}
	.check input {
		width: 16px;
		height: 16px;
		accent-color: var(--accent);
	}
</style>
