<!--
	The notification channels of one scope: a project's, or the global ones
	(Settings). Lists them and adds, edits, pauses, tests and deletes through
	the page's form actions (`?/addChannel`, `?/updateChannel`,
	`?/toggleChannel`, `?/testChannel`, `?/deleteChannel`, `?/telegramChats`),
	which both pages take from `server/admin/notify.ts`. Credentials are typed
	once and never shown again; a webhook channel's signing secret is revealed
	once on creation.
-->
<script lang="ts">
	import { deserialize, enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { CHANNEL_KINDS, NOTIFICATION_TYPE_OPTIONS, channelKind, notificationTypeLabel, sendErrorText, type ChannelKind, type ChannelRow } from '$lib/notify';
	import type { StatusView } from '$lib/status';
	import { toast } from '$lib/ui.svelte';
	import Callout from './Callout.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import EmptyState from './EmptyState.svelte';
	import Icon from './Icon.svelte';
	import RevealSecrets from './RevealSecrets.svelte';
	import Sheet from './Sheet.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import Time from './Time.svelte';

	let {
		channels,
		scope,
		allowLocal = false,
		globalCount = 0
	}: { channels: ChannelRow[]; scope: 'global' | 'project'; allowLocal?: boolean; globalCount?: number } = $props();

	const statusOf = (c: ChannelRow): StatusView =>
		!c.enabled ? { tone: 'muted', label: 'Paused' } : c.lastError ? { tone: 'danger', label: 'Failing' } : { tone: 'success', label: 'Active' };

	const GENERIC_ERROR = 'Something went wrong. Try again.';
	const errorOf = (data: Record<string, unknown> | undefined) => (typeof data?.error === 'string' ? data.error : GENERIC_ERROR);

	/* ---- add / edit ----------------------------------------------------- */
	type Draft = {
		id: string | null;
		kind: ChannelKind;
		label: string;
		types: string[];
		url: string;
		botToken: string;
		chatId: string;
		threadId: string;
		test: boolean;
	};
	const blank = (): Draft => ({
		id: null,
		kind: 'discord',
		label: '',
		types: NOTIFICATION_TYPE_OPTIONS.map((t) => t.type),
		url: '',
		botToken: '',
		chatId: '',
		threadId: '',
		test: true
	});
	let sheetOpen = $state(false);
	let draft = $state<Draft>(blank());
	let saving = $state(false);
	let sheetError = $state<string | null>(null);

	type Chat = { chatId: string; title: string; type: string; threadId: number | null };
	let chats = $state<Chat[] | null>(null);
	let chatsBusy = $state(false);
	let chatsError = $state<string | null>(null);

	function openSheet(c?: ChannelRow) {
		draft = c ? { ...blank(), id: c.id, kind: c.kind as ChannelKind, label: c.label, types: [...c.types] } : blank();
		sheetError = null;
		chats = null;
		chatsError = null;
		sheetOpen = true;
	}

	function pickKind(kind: ChannelKind) {
		draft.kind = kind;
		draft.url = '';
		sheetError = null;
	}

	/** Asks Telegram which chats the bot has seen, so the chat id need not be hunted down. */
	async function findChats() {
		chatsBusy = true;
		chatsError = null;
		try {
			const body = new FormData();
			body.set('botToken', draft.botToken);
			const res = await fetch('?/telegramChats', { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await res.text());
			if (result.type === 'success' && Array.isArray(result.data?.chats)) chats = result.data.chats as Chat[];
			else chatsError = result.type === 'failure' ? errorOf(result.data) : GENERIC_ERROR;
		} catch {
			chatsError = GENERIC_ERROR;
		} finally {
			chatsBusy = false;
		}
	}
	function pickChat(chat: Chat) {
		draft.chatId = chat.chatId;
		draft.threadId = chat.threadId === null ? '' : String(chat.threadId);
	}
	const chatPicked = (chat: Chat) => draft.chatId === chat.chatId && draft.threadId === (chat.threadId === null ? '' : String(chat.threadId));

	type Secret = { label: string; env: string; value: string };
	let revealed = $state<Secret[]>([]);
	let revealOpen = $state(false);

	const submitSheet: SubmitFunction = () => {
		saving = true;
		sheetError = null;
		const editing = draft.id !== null;
		return async ({ result, update }) => {
			saving = false;
			if (result.type === 'failure') {
				sheetError = errorOf(result.data);
				return;
			}
			if (result.type !== 'success') {
				sheetError = GENERIC_ERROR;
				return;
			}
			sheetOpen = false;
			// A pasted token or URL does not stay in the page once it is saved.
			draft = blank();
			chats = null;
			const test = result.data?.test as { ok: boolean; message: string | null } | undefined;
			if (editing) toast('Channel saved');
			else if (!test) toast('Channel added');
			else if (test.ok) toast('Channel added and the test went through');
			else toast(`Channel added. ${test.message ?? 'The test did not go through.'}`, 'danger');
			await update({ reset: false });
			const secrets = result.data?.revealed;
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
				if (result.type === 'failure') toast(errorOf(result.data), 'danger');
				else if (result.type === 'error') toast(GENERIC_ERROR, 'danger');
				else toast(success);
				await update({ reset: false });
			};
		};
	}

	/** The toast says what was just asked for: the form's own `enabled`, not the row as it was when it mounted. */
	const toggle = (key: string): SubmitFunction => (input) =>
		quiet(key, input.formData.get('enabled') === 'true' ? 'Channel resumed' : 'Channel paused')(input);

	let confirmDelete = $state<{ id: string; label: string } | null>(null);
	let deleteOpen = $state(false);
</script>

<section class="card" aria-labelledby="notify-title">
	<header>
		<h2 id="notify-title">Notifications</h2>
		{#if channels.length > 0}
			<button type="button" class="btn sm" onclick={() => openSheet()}><Icon name="plus" size={14} />Add channel</button>
		{/if}
	</header>
	{#if channels.length === 0}
		<div class="none">
			<EmptyState icon="bell" title="Hear about every payment">
				<p>
					{#if scope === 'global'}
						Get a message in Discord, in Telegram or at your own URL each time money comes in, in any project.
					{:else}
						Get a message in Discord, in Telegram or at your own URL each time this project receives a payment.
					{/if}
				</p>
				<button type="button" class="btn primary" onclick={() => openSheet()}><Icon name="plus" size={14} />Add channel</button>
			</EmptyState>
		</div>
	{:else}
		<ul class="channels">
			{#each channels as c (c.id)}
				{@const kind = channelKind(c.kind)}
				<li class:paused={!c.enabled}>
					<span class="tile" aria-hidden="true"><Icon name={kind.icon} size={16} /></span>
					<div class="what">
						<div class="line">
							<span class="label">{c.label}</span>
							<StatusBadge status={statusOf(c)} />
						</div>
						<div class="meta">{kind.name} · <span class="mono">{c.hint}</span> · {c.types.map(notificationTypeLabel).join(', ')}</div>
						<div class="meta">
							{#if c.enabled && c.lastError}
								<span class="tone-danger">Last send failed: {sendErrorText(c.lastError)} · <Time at={c.lastErrorAt} /></span>
							{:else if c.lastSentAt}
								<span>Last sent <Time at={c.lastSentAt} /></span>
							{:else}
								<span>Nothing sent yet</span>
							{/if}
						</div>
					</div>
					<div class="row-actions">
						<form method="POST" action="?/testChannel" use:enhance={quiet(`test:${c.id}`, 'Test sent. Check the channel.')}>
							<input type="hidden" name="channelId" value={c.id} />
							<button type="submit" class="btn ghost sm" disabled={busy === `test:${c.id}`}>{busy === `test:${c.id}` ? 'Sending…' : 'Send test'}</button>
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
						<form method="POST" action="?/toggleChannel" use:enhance={toggle(`toggle:${c.id}`)}>
							<input type="hidden" name="channelId" value={c.id} />
							<input type="hidden" name="enabled" value={c.enabled ? 'false' : 'true'} />
							<button
								type="submit"
								class="switch"
								role="switch"
								aria-checked={c.enabled}
								aria-label="Send notifications to {c.label}"
								title={c.enabled ? 'Pause' : 'Resume'}
								disabled={busy === `toggle:${c.id}`}><span></span></button
							>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
	{#if scope === 'project'}
		<p class="foot">
			{#if globalCount > 0}
				{globalCount === 1 ? '1 global channel also hears' : `${globalCount} global channels also hear`} about this project.
				<a href="/admin/settings">Manage in Settings</a>
			{:else}
				A channel added in <a href="/admin/settings">Settings</a> hears about every project.
			{/if}
		</p>
	{/if}
</section>

<Sheet bind:open={sheetOpen} title={draft.id ? 'Edit channel' : 'Add channel'} busy={saving}>
	<form id="channel-form" method="POST" action={draft.id ? '?/updateChannel' : '?/addChannel'} class="stack" use:enhance={submitSheet}>
		{#if draft.id}
			<input type="hidden" name="channelId" value={draft.id} />
		{:else}
			<fieldset class="field plain">
				<legend class="label">Send to</legend>
				<div class="kinds">
					{#each CHANNEL_KINDS as k (k.kind)}
						<label class="kind">
							<input type="radio" name="kind" value={k.kind} checked={draft.kind === k.kind} onchange={() => pickKind(k.kind)} />
							<span class="kind-card">
								<Icon name={k.icon} size={18} />
								<span class="kind-name">{k.name}</span>
								<span class="hint">{k.about}</span>
							</span>
						</label>
					{/each}
				</div>
			</fieldset>

			{#if draft.kind === 'discord'}
				<div class="field">
					<label for="channel-url">Webhook URL</label>
					<input
						id="channel-url"
						name="url"
						class="input mono"
						type="url"
						required
						autocomplete="off"
						spellcheck="false"
						placeholder="https://discord.com/api/webhooks/…"
						bind:value={draft.url}
					/>
					<span class="hint">In Discord, open the channel's settings, then Integrations → Webhooks → New webhook → Copy webhook URL.</span>
				</div>
			{:else if draft.kind === 'telegram'}
				<div class="field">
					<label for="channel-token">Bot token</label>
					<input
						id="channel-token"
						name="botToken"
						class="input mono"
						required
						autocomplete="off"
						spellcheck="false"
						placeholder="123456789:AA…"
						bind:value={draft.botToken}
					/>
					<span class="hint">Make a bot with @BotFather, then add it to your group or channel, or send it a message.</span>
				</div>
				<div class="field">
					<div class="label-row">
						<label for="channel-chat">Chat</label>
						<button type="button" class="btn ghost sm" disabled={chatsBusy || !draft.botToken.trim()} onclick={findChats}>
							<Icon name="search" size={14} />{chatsBusy ? 'Looking…' : chats ? 'Look again' : 'Find my chats'}
						</button>
					</div>
					{#if chatsError}
						<span class="error" role="alert">{chatsError}</span>
					{:else if chats && chats.length === 0}
						<span class="hint" role="status">The bot has not seen a chat yet. Send a message where it should post, then look again.</span>
					{:else if chats}
						<ul class="chats" aria-label="Chats this bot has seen">
							{#each chats as chat (`${chat.chatId}:${chat.threadId}`)}
								<li>
									<button type="button" class="chat" aria-pressed={chatPicked(chat)} onclick={() => pickChat(chat)}>
										<span class="chat-title">{chat.title}{#if chat.threadId !== null}<span class="subtle"> · topic {chat.threadId}</span>{/if}</span>
										<span class="hint">{chat.type} · {chat.chatId}</span>
									</button>
								</li>
							{/each}
						</ul>
					{/if}
					<input
						id="channel-chat"
						name="chatId"
						class="input mono"
						required
						autocomplete="off"
						spellcheck="false"
						placeholder="-1001234567890"
						bind:value={draft.chatId}
					/>
					<span class="hint">The chat's id: a number, negative for groups and channels. A public channel's @name works too.</span>
				</div>
				<div class="field">
					<label for="channel-thread">Topic id <span class="subtle">(optional)</span></label>
					<input id="channel-thread" name="threadId" class="input mono" inputmode="numeric" autocomplete="off" bind:value={draft.threadId} />
					<span class="hint">Only for a group that uses topics.</span>
				</div>
			{:else}
				<div class="field">
					<label for="channel-url">URL</label>
					<input
						id="channel-url"
						name="url"
						class="input mono"
						type="url"
						required
						autocomplete="off"
						spellcheck="false"
						placeholder="https://example.com/hooks/payments"
						bind:value={draft.url}
					/>
					<span class="hint">
						{allowLocal ? 'https://, or http://localhost in sandbox.' : 'https:// only.'} Each notification is POSTed as JSON and signed like a project webhook. You
						get the signing secret once, right after adding.
					</span>
				</div>
			{/if}
		{/if}
		<div class="field">
			<label for="channel-label">Name <span class="subtle">(optional)</span></label>
			<input id="channel-label" name="label" class="input" maxlength="60" bind:value={draft.label} autocomplete="off" placeholder={channelKind(draft.kind).name} />
			<span class="hint">Only shown here, to tell channels apart.</span>
		</div>
		<fieldset class="field plain">
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
		{:else}
			<label class="check">
				<input type="checkbox" name="test" value="1" bind:checked={draft.test} />
				<span>Send a test message now<span class="hint">A made-up payment marked [Test], to check it arrives.</span></span>
			</label>
		{/if}
		{#if sheetError}<Callout tone="danger" role="alert">{sheetError}</Callout>{/if}
	</form>
	{#snippet footer()}
		<button type="button" class="btn" disabled={saving} onclick={() => (sheetOpen = false)}>Cancel</button>
		<button type="submit" form="channel-form" class="btn primary" disabled={saving}>
			{saving ? (draft.id || !draft.test ? 'Saving…' : 'Adding and testing…') : draft.id ? 'Save' : 'Add channel'}
		</button>
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
	.none {
		padding: var(--space-4);
	}
	.none p {
		max-width: 44ch;
		font-size: var(--text-sm);
	}
	.none .btn {
		margin-top: var(--space-2);
	}
	.channels {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.channels > li {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
	}
	.channels > li + li {
		border-top: 1px solid var(--border);
	}
	.tile {
		flex: none;
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-md);
		border: 1px solid var(--border);
		background: var(--bg-inset);
		color: var(--fg-muted);
	}
	.what {
		flex: 1;
		display: grid;
		gap: 2px;
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
	.paused .label,
	.paused .tile {
		color: var(--fg-subtle);
	}
	.meta {
		font-size: var(--text-xs);
		color: var(--fg-subtle);
		overflow-wrap: anywhere;
	}
	.row-actions {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}
	.row-actions form {
		display: contents;
	}
	.switch {
		flex: none;
		width: 32px;
		height: 18px;
		margin-left: var(--space-2);
		padding: 2px;
		border: 0;
		border-radius: 999px;
		background: var(--border-strong);
		cursor: pointer;
		transition: background 120ms ease;
	}
	.switch span {
		display: block;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #fff;
		box-shadow: var(--shadow-sm);
		transition: transform 120ms ease;
	}
	.switch[aria-checked='true'] {
		background: var(--accent);
	}
	.switch[aria-checked='true'] span {
		transform: translateX(14px);
	}
	.switch:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}
	.switch:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.foot {
		padding: var(--space-3) var(--space-4);
		border-top: 1px solid var(--border);
		font-size: var(--text-xs);
		color: var(--fg-subtle);
	}

	/* ---- the sheet ---- */
	.plain {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.plain legend {
		padding: 0;
		margin-bottom: var(--space-1);
	}
	.kinds {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
	}
	.kind input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.kind-card {
		display: grid;
		gap: 2px;
		justify-items: start;
		height: 100%;
		padding: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg);
		color: var(--fg-muted);
		cursor: pointer;
	}
	.kind-card:hover {
		border-color: var(--border-strong);
	}
	.kind-name {
		margin-top: var(--space-1);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--fg);
	}
	.kind input:checked + .kind-card {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
		background: var(--accent-subtle);
		color: var(--accent-text);
	}
	.kind input:focus-visible + .kind-card {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}
	.label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.label-row label {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}
	.chats {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		max-height: 196px;
		overflow-y: auto;
	}
	.chats li + li {
		border-top: 1px solid var(--border);
	}
	.chat {
		display: grid;
		gap: 1px;
		width: 100%;
		padding: var(--space-2) var(--space-3);
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.chat:hover {
		background: var(--bg-inset);
	}
	.chat[aria-pressed='true'] {
		background: var(--accent-subtle);
	}
	.chat:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}
	.chat-title {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
	}
	.check {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-regular);
		cursor: pointer;
	}
	.check input {
		margin-top: 3px;
	}
	.hint {
		font-size: var(--text-xs);
		color: var(--fg-subtle);
	}
	.check .hint {
		display: block;
	}
	.error {
		font-size: var(--text-xs);
		color: var(--danger-fg);
	}
	@media (max-width: 639px) {
		.channels > li {
			flex-wrap: wrap;
		}
		.row-actions {
			width: 100%;
			padding-left: 44px;
		}
		.row-actions .switch {
			margin-left: auto;
		}
		.kinds {
			grid-template-columns: 1fr;
		}
		.kind-card {
			grid-template-columns: auto 1fr;
			column-gap: var(--space-2);
			align-items: center;
		}
		.kind-name {
			margin-top: 0;
		}
		.kind-card .hint {
			grid-column: 2;
		}
	}
</style>
