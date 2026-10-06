<script lang="ts">
	import type { Snippet } from 'svelte';
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Icon, { type IconName } from '$lib/components/Icon.svelte';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
	import BrandLogo from '$lib/components/brand/BrandLogo.svelte';
	import { t, type MessageKey } from '$lib/i18n/en';
	import { scopedHref } from '$lib/url';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	type Item = { key: MessageKey; path: string; icon: IconName; hotkey: string };
	const MAIN: Item[] = [
		{ key: 'nav.overview', path: '/admin', icon: 'home', hotkey: 'o' },
		{ key: 'nav.payments', path: '/admin/payments', icon: 'receipt', hotkey: 'p' },
		{ key: 'nav.subscriptions', path: '/admin/subscriptions', icon: 'repeat', hotkey: 's' },
		{ key: 'nav.charges', path: '/admin/charges', icon: 'coins', hotkey: 'c' },
		{ key: 'nav.cards', path: '/admin/cards', icon: 'card', hotkey: 'd' },
		{ key: 'nav.events', path: '/admin/events', icon: 'send', hotkey: 'e' }
	];
	const MORE: Item[] = [
		{ key: 'nav.projects', path: '/admin/projects', icon: 'folder', hotkey: 'j' },
		{ key: 'nav.usage', path: '/admin/usage', icon: 'chart', hotkey: 'u' },
		{ key: 'nav.settings', path: '/admin/settings', icon: 'settings', hotkey: ',' }
	];
	const ALL = [...MAIN, ...MORE];

	let drawer = $state(false);
	let search: HTMLInputElement | undefined = $state();
	let pendingG = false;

	const path = $derived(page.url.pathname);
	const isActive = (item: Item) => (item.path === '/admin' ? path === '/admin' : path === item.path || path.startsWith(`${item.path}/`));
	const scoped = (p: string) => (p.startsWith('/admin/projects') || p === '/admin/settings' ? p : scopedHref(p, data.scope));

	const crumbs = $derived.by(() => {
		const parts = path.split('/').filter(Boolean).slice(1);
		const section = ALL.find((i) => i.path === `/admin/${parts[0] ?? ''}`) ?? MAIN[0]!;
		const out: { label: string; href?: string }[] = [{ label: t(section.key), href: parts.length > 1 ? scoped(section.path) : undefined }];
		if (parts[1]) out.push({ label: parts[1] === 'new' ? 'New' : `${parts[1].slice(0, 6)}…${parts[1].slice(-4)}` });
		return out;
	});

	afterNavigate(() => (drawer = false));

	function onKey(e: KeyboardEvent) {
		const el = e.target as HTMLElement | null;
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
		if (document.querySelector('dialog[open]')) return;
		if (e.key === '/') {
			e.preventDefault();
			search?.focus();
			return;
		}
		if (pendingG) {
			pendingG = false;
			const item = ALL.find((i) => i.hotkey === e.key);
			if (item) {
				e.preventDefault();
				goto(scoped(item.path));
			}
			return;
		}
		if (e.key === 'g') {
			pendingG = true;
			setTimeout(() => (pendingG = false), 1200);
		}
	}
</script>

<svelte:window onkeydown={onKey} />

{#snippet navItem(item: Item)}
	<a
		href={scoped(item.path)}
		class="nav-item"
		class:active={isActive(item)}
		aria-current={isActive(item) ? 'page' : undefined}
		title="{t(item.key)}  G {item.hotkey.toUpperCase()}"
	>
		<Icon name={item.icon} />
		<span class="label">{t(item.key)}</span>
		{#if item.key === 'nav.events' && data.failing > 0}
			<span class="count" aria-label="{data.failing} failing">{data.failing}</span>
		{/if}
		{#if item.key === 'nav.settings' && data.settingsProblem}
			<span class="warn-dot" aria-label="needs attention"></span>
		{/if}
	</a>
{/snippet}

<div class="app">
	<aside class="sidebar" class:open={drawer} aria-label="Main">
		<a class="brand" href={resolve('/admin')} aria-label="{data.brand.companyName ?? 'Bogts'}: overview">
			<BrandLogo src={data.brand.logoUrl} name={data.brand.companyName} size={30} />
			<span class="names">
				<span class="name">{data.brand.companyName ?? 'Bogts'}</span>
				<span class="host" title={data.host}>{data.host}</span>
			</span>
		</a>
		<ProjectSwitcher projects={data.projects} scope={data.scope} />
		<nav>
			{#each MAIN as item (item.key)}{@render navItem(item)}{/each}
			<hr />
			{#each MORE as item (item.key)}{@render navItem(item)}{/each}
		</nav>
		<footer>
			<span class="env-line" class:live={data.env.mode === 'production'} class:test={data.env.mode === 'sandbox' || data.env.mode === 'mixed'}>
				<span class="env-dot" aria-hidden="true"></span>
				{#if data.env.mode === 'production'}Production{:else if data.env.mode === 'none'}No provider on{:else}{data.env.mode === 'mixed' ? 'Mixed' : 'Sandbox'} · {data.env.sandbox.join(', ')}{/if}
			</span>
			{#if data.authMode === 'password'}
				<form method="POST" action="/admin/logout">
					<button type="submit" class="nav-item signout"><Icon name="logout" /><span>{t('nav.signOut')}</span></button>
				</form>
			{:else if data.admin?.method === 'access'}
				<span class="who subtle" title={data.admin.email}>{data.admin.email}</span>
			{/if}
		</footer>
	</aside>
	{#if drawer}
		<button type="button" class="scrim" aria-label="Close menu" onclick={() => (drawer = false)}></button>
	{/if}

	<div class="main">
		<div class="topbar">
			<button type="button" class="btn ghost sm menu" aria-label="Menu" aria-expanded={drawer} onclick={() => (drawer = !drawer)}>
				<Icon name="menu" />
			</button>
			<nav class="crumbs" aria-label="Breadcrumb">
				{#each crumbs as c, i (i)}
					{#if i > 0}<span class="sep" aria-hidden="true">/</span>{/if}
					{#if c.href}<a href={c.href}>{c.label}</a>{:else}<span class:mono={i > 0} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span>{/if}
				{/each}
			</nav>
			<form class="search" method="GET" action="/admin/search" role="search">
				<Icon name="search" size={14} />
				<input
					bind:this={search}
					name="q"
					class="input"
					placeholder={t('nav.search')}
					aria-label="Search by id, reference or customer"
					autocomplete="off"
					spellcheck="false"
					onkeydown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
				/>
				<kbd aria-hidden="true">/</kbd>
			</form>
		</div>
		<main class="content">
			{@render children()}
		</main>
	</div>
</div>

<style>
	.app {
		display: grid;
		grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
		min-height: 100vh;
	}
	.sidebar {
		position: sticky;
		top: 0;
		height: 100vh;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-3);
		background: var(--bg-subtle);
		border-right: 1px solid var(--border);
		overflow-y: auto;
	}
	:global(.theme-root:has(.banner)) .sidebar {
		top: var(--banner-h);
		height: calc(100dvh - var(--banner-h));
	}
	.brand {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2);
		margin: calc(var(--space-1) * -1) 0 var(--space-1);
		border-radius: var(--radius-lg);
		color: var(--fg);
		min-width: 0;
	}
	.brand:hover {
		text-decoration: none;
		background: var(--bg-muted);
	}
	.names {
		display: grid;
		min-width: 0;
		line-height: 1.25;
	}
	.name {
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.01em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.host {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-xs);
		font-weight: var(--weight-regular);
		color: var(--fg-muted);
	}
	nav {
		display: grid;
		gap: 1px;
	}
	hr {
		border: 0;
		border-top: 1px solid var(--border);
		margin: var(--space-2) 0;
	}
	.nav-item {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		height: 32px;
		padding: 0 var(--space-2);
		border-radius: var(--radius-md);
		color: var(--fg-muted);
		font: var(--weight-medium) var(--text-sm) var(--font-sans);
		text-decoration: none;
		background: none;
		border: 0;
		width: 100%;
		cursor: pointer;
	}
	.nav-item :global(.icon) {
		color: var(--fg-subtle);
		transition: color var(--dur-fast) var(--ease);
	}
	.nav-item:hover {
		background: var(--bg-muted);
		color: var(--fg);
		text-decoration: none;
	}
	.nav-item:hover :global(.icon) {
		color: var(--fg-muted);
	}
	.nav-item.active {
		background: var(--bg);
		color: var(--fg);
		box-shadow: var(--shadow-sm), 0 0 0 1px var(--border);
	}
	.nav-item.active :global(.icon) {
		color: var(--accent-text);
	}
	.nav-item.active::before {
		content: '';
		position: absolute;
		left: -12px;
		top: 7px;
		bottom: 7px;
		width: 3px;
		border-radius: 0 3px 3px 0;
		background: var(--accent);
	}
	.label {
		flex: 1;
	}
	.count {
		min-width: 20px;
		height: 18px;
		padding: 0 6px;
		border-radius: var(--radius-full);
		background: var(--danger-solid);
		color: #fff;
		font-size: 11px;
		line-height: 18px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}
	.warn-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--warning-fg);
	}
	footer {
		margin-top: auto;
		display: grid;
		gap: var(--space-1);
		font-size: var(--text-xs);
	}
	.env-line {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 var(--space-2);
		color: var(--fg-subtle);
	}
	.env-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--fg-subtle);
		flex: none;
	}
	.env-line.live .env-dot {
		background: var(--success-fg);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--success-fg) 22%, transparent);
	}
	.env-line.test .env-dot {
		background: var(--warning-fg);
	}
	.who {
		padding: 0 var(--space-2);
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.main {
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.topbar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		height: var(--topbar-h);
		padding: 0 var(--space-6);
		background: color-mix(in srgb, var(--bg-subtle) 88%, transparent);
		backdrop-filter: blur(8px);
		border-bottom: 1px solid var(--border);
	}
	:global(.theme-root:has(.banner)) .topbar {
		top: var(--banner-h);
	}
	.menu {
		display: none;
	}
	.crumbs {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
		min-width: 0;
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
	}
	.crumbs a {
		color: var(--fg-muted);
	}
	.crumbs .sep {
		color: var(--fg-subtle);
	}
	.crumbs .mono {
		font-size: var(--text-xs);
	}
	.search {
		position: relative;
		display: flex;
		align-items: center;
		width: 260px;
		color: var(--fg-subtle);
	}
	.search :global(.icon) {
		position: absolute;
		left: 10px;
	}
	.search .input {
		padding-left: 30px;
		padding-right: 28px;
		height: 30px;
		font-size: var(--text-sm);
	}
	kbd {
		position: absolute;
		right: 8px;
		font: var(--text-xs) var(--font-mono);
		padding: 0 5px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--fg-subtle);
	}
	.content {
		width: 100%;
		max-width: 1280px;
		padding: var(--space-6);
		margin: 0 auto;
	}
	.scrim {
		display: none;
	}
	@media (max-width: 959px) {
		.app {
			grid-template-columns: minmax(0, 1fr);
		}
		.sidebar {
			position: fixed;
			z-index: 40;
			left: 0;
			top: 0;
			width: min(280px, 85vw);
			height: 100dvh;
			transform: translateX(-100%);
			transition: transform var(--dur-base) var(--ease);
			background: var(--bg);
		}
		:global(.theme-root:has(.banner)) .sidebar {
			top: 0;
			height: 100dvh;
		}
		.sidebar.open {
			transform: none;
			box-shadow: var(--shadow-lg);
		}
		.scrim {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 35;
			border: 0;
			background: var(--overlay);
		}
		.menu {
			display: inline-flex;
		}
		.topbar {
			padding: 0 var(--space-4);
			gap: var(--space-2);
		}
		.content {
			padding: var(--space-4);
		}
	}
	@media (max-width: 639px) {
		.search {
			width: 40px;
			flex: none;
		}
		.search .input {
			padding: 0;
			width: 36px;
			color: transparent;
			cursor: pointer;
		}
		.search .input::placeholder {
			color: transparent;
		}
		.search .input:focus {
			position: fixed;
			left: var(--space-4);
			right: var(--space-4);
			width: auto;
			padding-left: var(--space-3);
			color: var(--fg);
			z-index: 30;
		}
		.search :global(.icon) {
			left: 11px;
			pointer-events: none;
		}
		kbd {
			display: none;
		}
	}
</style>
