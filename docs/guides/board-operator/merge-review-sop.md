# Merge Review SOP

## Goal

Keep merge review failures separable:

- `environment`: broken worktree install or missing package files
- `migrations`: duplicate or out-of-order DB numbering / journal drift
- `code`: typecheck or behavior regressions
- `build`: production bundle/build failures

## Recommended order

1. Run `pnpm worktree:repair`
2. Run `pnpm verify:merge-ready`
3. If you want the heavier pass, run `pnpm verify:merge-ready:full`

This order prevents a corrupted secondary worktree from being mistaken for a branch regression.

## If migrations collide

When `packages/db` reports duplicate migration numbers or `_journal.json` drift:

1. Run `pnpm db:renumber-migrations`
2. Re-run `pnpm --filter @paperclipai/db run check:migrations`
3. Re-run `pnpm verify:merge-ready`

The renumber tool normalizes migration filenames and `_journal.json`. It also renames matching snapshot files when that rename is unambiguous.

## If code checks fail

`verify:merge-ready` can tell you the failure is in the `code` layer, but it cannot by itself decide whether that failure is branch-specific or an existing baseline issue.

When a code-layer check fails:

1. Run the same command on the feature branch
2. Run the same command on a clean `origin/master` worktree
3. Treat only the delta as a merge blocker

## Worktree recovery

`pnpm worktree:repair` checks for the dependency corruption we have actually hit in secondary worktrees:

- Rollup native optional packages missing or unreadable
- `lucide-react` generated icon modules missing from `.pnpm`

If the quick check fails, it retries with:

1. `pnpm install --frozen-lockfile`
2. `pnpm install --force --config.confirmModulesPurge=false`

`scripts/provision-worktree.sh` now runs this repair step automatically after provisioning a worktree install.
