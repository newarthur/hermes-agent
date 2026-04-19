# Hermes Local Upgrade SOP

## Goal
Keep `main` clean and easy to upgrade while carrying local Hermes patches on dedicated branches.

## Branch roles
- `main`: should stay aligned with `origin/main`
- local patch branches: hold custom work (for example `fix/local-provider-routing-patches-20260419`)
- never keep long-lived local modifications directly on `main`

## Normal upgrade flow
```bash
git checkout main
hermes update
```

Equivalent explicit git flow:
```bash
git checkout main
git fetch origin --quiet
git pull --ff-only origin main
```

## If local patch work exists
After `main` is updated:
```bash
git checkout fix/local-provider-routing-patches-20260419
git rebase main
```

If conflicts appear:
1. resolve them on the patch branch, not on `main`
2. keep upstream compatibility fixes where appropriate
3. re-run targeted tests
4. push the rebased branch:
   ```bash
   git push --force-with-lease
   ```

## If you need to protect uncommitted work before syncing
```bash
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR=~/.hermes/git-backups/hermes-update-$TS
mkdir -p "$BACKUP_DIR"
git status --porcelain=v1 > "$BACKUP_DIR/status-before.txt"
git diff > "$BACKUP_DIR/working-tree.diff"
git diff --cached > "$BACKUP_DIR/index.diff"
git stash push -u -m "pre-sync-protect-$TS"
```

## If fork/main must be reset to upstream/main
Use only when you intentionally want your fork `main` to fully match upstream:
```bash
git checkout main
git fetch origin --quiet
git fetch upstream --quiet
git branch backup/main-before-upstream-sync-$(date +%Y%m%d) HEAD
git tag backup/main-before-upstream-sync-$(date +%Y%m%d)-$(git rev-parse --short HEAD) HEAD
git reset --hard upstream/main
git push origin main --force-with-lease
```

## Rules
- do not develop directly on `main`
- commit local work before sync/rebase/reset operations
- push important patch branches to origin
- keep backup tags/branches before destructive resets
- treat stash as temporary transport, not permanent storage

## Current recommended pattern for this repo
```bash
# upgrade main
git checkout main
hermes update

# continue local patch work
git checkout fix/local-provider-routing-patches-20260419
git rebase main
```
