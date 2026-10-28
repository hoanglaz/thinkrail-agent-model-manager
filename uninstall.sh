#!/usr/bin/env bash
#
# Uninstall the agent-model-pins extension.
#
# By default only the extension code (index.ts) is removed - your config.json is
# kept, because it is your data. Use --purge to delete the whole directory.

set -euo pipefail

EXTENSION_NAME="agent-model-pins"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PURGE=0
RESTORE=0
ASSUME_YES=0
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: ./uninstall.sh [options]

Options:
  --agent-dir <path>  pi agent directory
                      (default: $PI_CODING_AGENT_DIR if set, else ~/.pi/agent)
  --restore-backup    restore the newest index.ts.backup-* instead of removing
  --purge             delete the whole extension directory, config.json included
  --yes               do not ask for confirmation (for --purge)
  --dry-run           print what would happen without changing anything
  -h, --help          show this help

Without --purge your config.json and any index.ts.backup-* files are kept.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --agent-dir)
      [ $# -ge 2 ] || { echo "error: --agent-dir needs a value" >&2; exit 2; }
      AGENT_DIR="$2"
      shift 2
      ;;
    --agent-dir=*)
      AGENT_DIR="${1#*=}"
      shift
      ;;
    --restore-backup)
      RESTORE=1
      shift
      ;;
    --purge)
      PURGE=1
      shift
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

TARGET_DIR="$AGENT_DIR/extensions/$EXTENSION_NAME"

if [ ! -d "$TARGET_DIR" ]; then
  echo "Nothing to uninstall: $TARGET_DIR does not exist."
  exit 0
fi

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

if [ "$RESTORE" -eq 1 ]; then
  LATEST_BACKUP=""
  for candidate in "$TARGET_DIR"/index.ts.backup-*; do
    [ -f "$candidate" ] || continue
    if [ -z "$LATEST_BACKUP" ] || [ "$candidate" -nt "$LATEST_BACKUP" ]; then
      LATEST_BACKUP="$candidate"
    fi
  done
  if [ -z "$LATEST_BACKUP" ]; then
    echo "error: no index.ts.backup-* found in $TARGET_DIR" >&2
    exit 1
  fi
  echo "Restoring $LATEST_BACKUP"
  run mv "$LATEST_BACKUP" "$TARGET_DIR/index.ts"
  echo "Done. Restart ThinkRail (or reload the session) to load the restored code."
  exit 0
fi

if [ "$PURGE" -eq 1 ]; then
  if [ "$ASSUME_YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    printf 'Delete %s and its config.json? [y/N] ' "$TARGET_DIR"
    reply=""
    read -r reply || reply=""
    case "$reply" in
      y|Y|yes|YES) ;;
      *) echo "Aborted - nothing was deleted."; exit 0 ;;
    esac
  fi
  echo "Removing $TARGET_DIR (config.json included)"
  run rm -rf "$TARGET_DIR"
  echo "Done. Restart ThinkRail (or reload the session) to unload the extension."
  exit 0
fi

echo "Removing the extension code from $TARGET_DIR"
run rm -f "$TARGET_DIR/index.ts"

echo
echo "Done."
echo "  kept: $TARGET_DIR/config.json (your pin configuration)"
if [ -f "$TARGET_DIR/config.json" ]; then
  echo "  to delete it too:  ./uninstall.sh --purge --yes"
fi
echo "  to roll the code back:  ./uninstall.sh --restore-backup"
echo "Restart ThinkRail (or reload the session) to unload the extension."
