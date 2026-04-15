---
title: Local Development
summary: Set up Paperclip for local development
---

Run Paperclip locally with zero external dependencies.

## Prerequisites

- Node.js 20+
- pnpm 9+

## Start Dev Server

```sh
pnpm install
pnpm dev
```

This starts:

- **API server** at `http://localhost:3100`
- **UI** served by the API server in dev middleware mode (same origin)

No Docker or external database required. Paperclip uses embedded PostgreSQL automatically.

## One-Command Bootstrap

For a first-time install:

```sh
pnpm paperclipai run
```

This does:

1. Auto-onboards if config is missing
2. Runs `paperclipai doctor` with repair enabled
3. Starts the server when checks pass

## Tailscale/Private Auth Dev Mode

To run in `authenticated/private` mode for network access:

```sh
pnpm dev --tailscale-auth
```

This binds the server to `0.0.0.0` for private-network access.

Alias:

```sh
pnpm dev --authenticated-private
```

Allow additional private hostnames:

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

For full setup and troubleshooting, see [Tailscale Private Access](/deploy/tailscale-private-access).

## Health Checks

```sh
curl http://localhost:3100/api/health
# -> {"status":"ok"}

curl http://localhost:3100/api/companies
# -> []
```

## Known Non-Blocking Warnings

### Codex remote plugin sync 403

When Paperclip runs with the `codex_local` adapter, Codex Desktop may emit warnings similar to:

- `startup remote plugin sync failed`
- `failed to warm featured plugin ids cache`
- `chatgpt authentication required`
- `403 Forbidden` from `https://chatgpt.com/backend-api/plugins/featured`

Treat these as **environment noise from Codex's remote plugin marketplace/auth flow**, not as a Paperclip platform regression.

What this means in practice:

- The warning originates from Codex Desktop or Codex cloud/plugin-marketplace auth.
- It does **not** by itself indicate that Paperclip heartbeat scheduling, issue routing, or writeback logic is broken.
- It does **not** require a Paperclip code fix unless local agent runs are also failing in a directly related way.

When to ignore it:

- local Paperclip health is still `ok`
- `codex_local` runs can still start and finish
- you are not relying on Codex's remote featured-plugin browsing/sync features

When it is actionable:

- you explicitly need Codex cloud/plugin marketplace features
- Codex itself cannot authenticate or launch local runs
- the warning correlates with actual adapter failures instead of appearing as standalone startup noise

If you need to fix it, do that in the Codex environment (sign-in, cloud/plugin permissions, or Codex-side config), not in the Paperclip repo.

## Reset Dev Data

To wipe local data and start fresh:

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## Data Locations

| Data | Path |
|------|------|
| Config | `~/.paperclip/instances/default/config.json` |
| Database | `~/.paperclip/instances/default/db` |
| Storage | `~/.paperclip/instances/default/data/storage` |
| Secrets key | `~/.paperclip/instances/default/secrets/master.key` |
| Logs | `~/.paperclip/instances/default/logs` |

Override with environment variables:

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```
