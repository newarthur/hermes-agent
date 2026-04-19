# Upgrade Commands

## Upgrade clean main
```bash
git checkout main
hermes update
```

## Rebase local patch branch after upgrade
```bash
git checkout fix/local-provider-routing-patches-20260419
git rebase main
git push --force-with-lease
```

## If rebase conflicts
```bash
git status
# fix files
 git add <files>
git rebase --continue
```

## Protect uncommitted work before risky sync
```bash
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR=~/.hermes/git-backups/hermes-update-$TS
mkdir -p "$BACKUP_DIR"
git status --porcelain=v1 > "$BACKUP_DIR/status-before.txt"
git diff > "$BACKUP_DIR/working-tree.diff"
git diff --cached > "$BACKUP_DIR/index.diff"
git stash push -u -m "pre-sync-protect-$TS"
```
