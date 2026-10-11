<!--
	The notification channels of one scope: a project's, or the global ones
	(Settings). Lists them and adds, edits, pauses, tests and deletes through
	the page's form actions (`?/addChannel`, `?/updateChannel`,
	`?/toggleChannel`, `?/testChannel`, `?/deleteChannel`), which both pages
	take from `server/admin/notify.ts`. Credentials are typed once and never
	shown again; a webhook channel's signing secret is revealed once on creation.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { CHANNEL_KINDS, NOTIFICATION_TYPE_OPTIONS, channelKindName, notificationTypeLabel, type ChannelKind, type ChannelRow } from '$lib/notify';
	import type { StatusView } from '$lib/status';
	import { toast } from '$lib/ui.svelte';
	import Callout from './Callout.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import Icon from './Icon.svelte';
	import RevealSecrets from './RevealSecrets.svelte';
	import Sheet from './Sheet.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import Time from './Time.svelte';

	let {
		channels,
		scope,
		allowLocal = false
	}: { channels: ChannelRow[]; scope: 'global' | 'project'; allowLocal?: boolean } = $props();

	const statusOf = (c: ChannelRow): StatusView =>
		!c.enabled ? { tone: 'muted', label: 'Paused' } : c.lastError ? { tone: 'danger', label: 'Failing' } : { tone: 'success', label: 'Active' };

	/* ---- add / edit ----------------------------------------------------- */
	type Draft = { id: string | null; kind: ChannelKind; label: string; types: string[] };
	const blank = (): Draft => ({ id: null, kind: 'discord', label: '', types: NOTIFICATION_TYPE_OPTIONS.map((t) => t.type) });
	let sheetOpen = $state(false);
	let draft = $state<Draft>(blank());
	let saving = $state(false);
	let sheetError = $state<string | null>(null);
	// Remounts the credential inputs, so a pasted token never survives the sheet.
	let sheetKey = $state(0);

	function openSheet(c?: ChannelRow) {
		draft = c ? { id: c.id, kind: c.kind as ChannelKind, label: c.label, types: [...c.types] } : blank();
		sheetError = null;
		sheetKey++;
		sheetOpen = true;
	}

	type Secret = { label: string; env: string; value: string };
	let revealed = $state<Secret[]>([]);
	let revealOpen = $state(false);

	const submitSheet: SubmitFunction = () => {
		saving = true;
		sheetError = null;
		return async ({ result, update }) => {
			saving = false;
			if (result.type === 'failure') {
				sheetError = typeof result.data?.error === 'string' ? result.data.error : 'Something went wrong. Try again.';
				return;
			}
			if (result.type === 'error') {
				sheetError = 'Something went wrong. Try again.';
				return;
			}
			sheetOpen = false;
			sheetKey++;
			toast(draft.id ? 'Channel saved' : 'Channel added');
			await update({ reset: true });
			const secrets = result.type === 'success' ? result.data?.revealed : null;
			if (Array.isArray(secrets) && secrets.length) {
				revealed = secrets as Secret[];
				revealOpen = true;
			}
		};
	};

	/* ---- row actions ---------------------------------------------------- */
	let busy = $state<string | null>(null);
	function quiet(key: string, success: string): SubmitFunction {
		return () => {
			busy = key;
			return async ({ result, update }) => {
				busy = null;
				if (result.type === 'failure') toast(typeof result.data?.error === 'string' ? result.data.error : 'Something went wrong. Try again.', 'danger');
				else if (result.type === 'error') toast('Something went wrong. Try again.', 'danger');
				else toast(success);
				await update({ reset: false });
			};
		};
	}

	let confirmDelete = $state<{ id: string; label: string } | null>(null);
	let deleteOpen = $state(false);
</script>

<section class="card" aria-labelledby="notify-title">
	<header>
		<h2 id="notify-title">Notifications</h2>
		<button type="button" class="btn sm" onclick={() => openSheet()}><Icon name="plus" size={14} />Add channel</button>
	</header>
	<p class="intro">
		{#if scope === 'global'}
			A message to Discord, Telegram or your own URL each time a payment is received, in any project.
		{:else}
			A message to Discord, Telegram or your own URL each time this project receives a payment. Channels in
			<a href="/admin/settings">Settings</a> hear about every project.
		{/if}
	</p>
	{#if channels.length > 0}
		<ul class="channels">
			{#each channels as c (c.id)}
				<li class:paused={!c.enabled}>
					<div class="what">
						<div class="line">
							<span class="tag">{channelKindName(c.kind)}</span>
							<span class="label">{c.label}</span>
							<StatusBadge status={statusOf(c)} />
						</div>
						<div class="meta">
							<span class="mono">{c.hint}</span>
							<span>{c.types.map(notificationTypeLabel).join(', ')}</span>
							{#if c.enabled && c.lastError}
								<span class="tone-danger">Last send failed ({c.lastError}), <Time at={c.lastErrorAt} /></span>
							{:else if c.lastSentAt}
								<span>Last sent <Time at={c.lastSentAt} /></span>
							{:else}
								<span>Nothing sent yet</span>
							{/if}
						</div>
					</div>
					<div class="row-actions">
						<form method="POST" action="?/testChannel" use:enhance={quiet(`test:${c.id}`, 'Test sent')}>
							<input type="hidden" name="channelId" value={c.id} />
							<button type="submit" class="btn ghost sm" disabled={busy === `test:${c.id}`}>{busy === `test:${c.id}` ? 'Sending…' : 'Send test'}</button>
						</form>
						<form method="POST" action="?/toggleChannel" use:enhance={quiet(`toggle:${c.id}`, c.enabled ? 'Channel paused' : 'Channel resumed')}>
							<input type="hidden" name="channelId" value={c.id} />
							<input type="hidden" name="enabled" value={c.enabled ? 'false' : 'true'} />
							<button type="submit" class="btn ghost sm" disabled={busy === `toggle:${c.id}`}>{c.enabled ? 'Pause' : 'Resume'}</button>
						</form>
						<button type="button" class="btn ghost sm" onclick={() => openSheet(c)}>Edit</button>
						<button
							type="button"
							class="btn ghost sm danger-text"
							onclick={() => {
								confirmDelete = { id: c.id, label: c.label };
								deleteOpen = true;
							}}>Delete</button
						>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<Sheet bind:open={sheetOpen} title={draft.id ? 'Edit channel' : 'Add channel'} busy={saving}>
	<form id="channel-form" method="POST" action={draft.id ? '?/updateChannel' : '?/addChannel'} class="stack" use:enhance={submitSheet}>
		{#if draft.id}
			<input type="hidden" name="channelId" value={draft.id} />
		{:else}
			<div class="field">
				<label for="channel-kind">Send to</label>
				<select id="channel-kind" name="kind" class="select" bind:value={draft.kind}>
					{#each CHANNEL_KINDS as k (k.kind)}
						<option value={k.kind}>{k.name}</option>
					{/each}
				</select>
			</div>
		{/if}
		<div class="field">
			<label for="channel-label">Name</label>
			<input id="channel-label" name="label" class="input" maxlength="60" bind:value={draft.label} autocomplete="off" placeholder={channelKindName(draft.kind)} />
			<span class="hint">Only shown here, to tell channels apart.</span>
		</div>
		{#if !draft.id}
			{#key sheetKey}
				{#if draft.kind === 'discord'}
					<div class="field">
						<label for="channel-url">Webhook URL</label>
						<input id="channel-url" name="url" class="input mono" type="url" required autocomplete="off" spellcheck="false" placeholder="https://discord.com/api/webhooks/…" />
						<span class="hint">In Discord: the channel's settings, Integrations, Webhooks, New webhook, Copy webhook URL.</span>
					</div>
				{:else if draft.kind === 'telegram'}
					<div class="field">
						<label for="channel-token">Bot token</label>
						<input id="channel-token" name="botToken" class="input mono" required autocomplete="off" spellcheck="false" placeholder="123456789:AA…" />
						<span class="hint">From @BotFather. Add the bot to the chat first.</span>
					</div>
					<div class="field">
						<label for="channel-chat">Chat id</label>
						<input id="channel-chat" name="chatId" class="input mono" required autocomplete="off" spellcheck="false" placeholder="-1001234567890" />
						<span class="hint">A number (negative for groups and channels), or a public @channel name.</span>
					</div>
					<div class="field">
						<label for="channel-thread">Topic id <span class="subtle">(optional)</span></label>
						<input id="channel-thread" name="threadId" class="input mono" inputmode="numeric" autocomplete="off" />
						<span class="hint">For a group with topics.</span>
					</div>
				{:else}
					<div class="field">
						<label for="channel-url">URL</label>
						<input id="channel-url" name="url" class="input mono" type="url" required autocomplete="off" spellcheck="false" placeholder="https://example.com/hooks/payments" />
						<span class="hint"
							>{allowLocal ? 'https://, or http://localhost in sandbox.' : 'https:// only.'} Each notification is POSTed as JSON, signed like project webhooks. The
							signing secret is shown once after you save.</span
						>
					</div>
				{/if}
			{/key}
		{/if}
		<fieldset class="field types">
			<legend class="label">Notify about</legend>
			{#each NOTIFICATION_TYPE_OPTIONS as t (t.type)}
				<label class="check">
					<input type="checkbox" name="types" value={t.type} bind:group={draft.types} />
					<span>{t.label}<span class="hint">{t.hint}</span></span>
				</label>
			{/each}
		</fieldset>
		{#if draft.id}
			<p class="hint">To change where a channel sends, delete it and add it again.</p>
		{/if}
		{#if sheetError}<Callout tone="danger" role="alert">{sheetError}</Callout>{/if}
	</form>
	{#snippet footer()}
		<button type="button" class="btn" disabled={saving} onclick={() => (sheetOpen = false)}>Cancel</button>
		<button type="submit" form="channel-form" class="btn primary" disabled={saving}>{saving ? 'Saving…' : draft.id ? 'Save' : 'Add channel'}</button>
	{/snippet}
</Sheet>

{#if confirmDelete}
	<ConfirmDialog
		bind:open={deleteOpen}
		title="Delete channel"
		action="?/deleteChannel"
		fields={{ channelId: confirmDelete.id }}
		confirmLabel="Delete channel"
		cancelLabel="Keep channel"
		busyLabel="Deleting…"
		successMessage="Channel deleted"
	>
		<p>Stops notifications to <strong>{confirmDelete.label}</strong> and forgets its credentials.</p>
	</ConfirmDialog>
{/if}

{#if revealed.length}
	<RevealSecrets
		bind:open={revealOpen}
		secrets={revealed}
		note="Verify each notification's Bogts-Signature header with this secret."
		lost="If lost, delete the channel and add it again."
		ondone={() => (revealed = [])}
	/>
{/if}

<style>
	.intro {
		padding: var(--space-3) var(--space-4);
		font-size: var(--text-sm);
		color: var(--fg-muted);
	}
	.channels {
		list-style: none;
		margin: 0;
		padding: 0;
		border-top: 1px solid var(--border);
	}
	.channels > li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
		padding: var(--space-3) var(--space-4);
	}
	.channels > li + li {
		border-top: 1px solid var(--border);
	}
	.what {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.line {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.label {
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
	}
	.paused .label {
		color: var(--fg-muted);
	}
	.meta {
		display: flex;
		gap: var(--space-1) var(--space-3);
		flex-wrap: wrap;
		font-size: var(--text-xs);
		color: var(--fg-subtle);
	}
	.row-actions {
		display: inline-flex;
		gap: 2px;
		flex-wrap: wrap;
	}
	.row-actions form {
		display: contents;
	}
	.types {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.check {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		font-weight: var(--weight-regular);
		cursor: pointer;
	}
	.check input {
		margin-top: 3px;
	}
	.check .hint {
		display: block;
	}
	p.hint {
		font-size: var(--text-xs);
		color: var(--fg-subtle);
	}
</style>
