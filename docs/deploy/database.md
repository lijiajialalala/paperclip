---
title: Database
summary: Embedded PGlite vs Docker Postgres vs hosted
---

Paperclip uses PostgreSQL via Drizzle ORM. There are three ways to run the database.

## 1. Embedded PostgreSQL (Default)

Zero config. If you don't set `DATABASE_URL`, the server starts an embedded PostgreSQL instance automatically.

```sh
pnpm dev
```

On first start, the server:

1. Creates `~/.paperclip/instances/default/db/` for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically
4. Starts serving requests

Data persists across restarts. To reset: `rm -rf ~/.paperclip/instances/default/db`.

The Docker quickstart also uses embedded PostgreSQL by default.

### Backups for Embedded PostgreSQL

Paperclip also creates SQL backups for the embedded database. By default:

1. Automatic backups are enabled
2. A snapshot runs every 60 minutes
3. Snapshots are kept for 30 days
4. Files are written to `~/.paperclip/instances/default/data/backups`

That default backup directory is inside the instance root. It protects you from a bad migration or a broken local DB, but it does **not** protect you if you delete or reset the whole `~/.paperclip/instances/default` folder.

If you want safer local recovery, point backups to a directory outside the Paperclip instance, such as OneDrive, Dropbox, iCloud Drive, or another synced folder:

```sh
# .env
PAPERCLIP_DB_BACKUP_ENABLED=true
PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=15
PAPERCLIP_DB_BACKUP_RETENTION_DAYS=30
PAPERCLIP_DB_BACKUP_DIR=~/paperclip-db-backups
```

Windows example:

```sh
PAPERCLIP_DB_BACKUP_DIR=C:/Users/<you>/OneDrive/paperclip-db-backups
```

You can also configure the same values through:

```sh
pnpm paperclipai configure --section database
```

To take an immediate snapshot instead of waiting for the timer:

```sh
pnpm paperclipai db:backup
```

The shorter alias works too:

```sh
pnpm db:backup
```

Company export is a different feature. `paperclipai company export` packages company content for reuse, but it is not a full database backup of your local instance.

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Set the connection string:

```sh
cp .env.example .env
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Push the schema:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted provider like [Supabase](https://supabase.com/).

1. Create a project at [database.new](https://database.new)
2. Copy the connection string from Project Settings > Database
3. Set `DATABASE_URL` in your `.env`

Use the **direct connection** (port 5432) for migrations and the **pooled connection** (port 6543) for the application.

If using connection pooling, disable prepared statements:

```ts
// packages/db/src/client.ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

## Switching Between Modes

| `DATABASE_URL` | Mode |
|----------------|------|
| Not set | Embedded PostgreSQL |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

The Drizzle schema (`packages/db/src/schema/`) is the same regardless of mode.
