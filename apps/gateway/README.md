# Bogts gateway

The Cloudflare Worker of [Bogts](https://github.com/gege-mn/bogts) («Богц»), the
open-source, self-hosted payment gateway for Mongolia (Bonum and QPay): the
`/v1` API, the provider webhooks and the `/admin` dashboard.

If you got here through the **Deploy to Cloudflare** button, this folder is now
your repository. Every push to it rebuilds and redeploys your Worker, and
`pnpm run deploy` applies any new D1 migrations before the new code goes live.

- Setup, providers, admin auth and upgrades: [docs/self-hosting.md](https://github.com/gege-mn/bogts/blob/main/docs/self-hosting.md)
- The API: [docs/api.md](https://github.com/gege-mn/bogts/blob/main/docs/api.md)
- Webhooks: [docs/webhooks.md](https://github.com/gege-mn/bogts/blob/main/docs/webhooks.md)
- Notifications to you (Discord, Telegram, JSON): [docs/notifications.md](https://github.com/gege-mn/bogts/blob/main/docs/notifications.md)

This folder stands alone on purpose (its own lockfile, `tsconfig.json` and
`.gitignore`), because the Deploy button copies only `apps/gateway`. In the
upstream monorepo, run `pnpm lockfile:gateway` after changing dependencies.
To deploy with your own settings, keep your own wrangler configs in a separate
private repo and deploy with `-c`.

Apache-2.0. See [LICENSE](LICENSE).
