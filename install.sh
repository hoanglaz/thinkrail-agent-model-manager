#!/usr/bin/env bash
#
# Install or update the agent-model-pins extension for ThinkRail / pi.
#
# Safe to re-run: an existing config.json is never modified, and an existing
# index.ts is backed up before it is replaced.
#
# No network access, no package manager, no dependencies.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_NAME="agent-model-pins"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options]

Options:
  --agent-dir <path>  pi agent directory
                      (default: $PI_CODING_AGENT_DIR if set, else ~/.pi/agent)
  --dry-run           print what would happen without changing anything
  -h, --help          show this help

Installs to <agent-dir>/extensions/agent-model-pins/.
  * index.ts            replaced; a previous copy is backed up first
  * config.json         created from config.example.json only if it is missing
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
SOURCE_EXTENSION="$SCRIPT_DIR/index.ts"
SOURCE_CONFIG="$SCRIPT_DIR/config.example.json"

for file in "$SOURCE_EXTENSION" "$SOURCE_CONFIG"; do
  if [ ! -f "$file" ]; then
    echo "error: missing $file - run install.sh from the repository root" >&2
    exit 1
  fi
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

echo "Installing $EXTENSION_NAME"
echo "  from: $SCRIPT_DIR"
echo "  to:   $TARGET_DIR"
echo

run mkdir -p "$TARGET_DIR"

BACKUP_PATH=""
if [ -f "$TARGET_DIR/index.ts" ]; then
  BACKUP_PATH="$TARGET_DIR/index.ts.backup-$(date +%Y%m%d%H%M%S)"
  echo "Existing index.ts found - backing it up:"
  echo "  $BACKUP_PATH"
  run cp "$TARGET_DIR/index.ts" "$BACKUP_PATH"
fi

echo "Copying index.ts"
run cp "$SOURCE_EXTENSION" "$TARGET_DIR/index.ts"

if [ -f "$TARGET_DIR/config.json" ]; then
  echo "Existing config.json found - keeping it unchanged"
else
  echo "No config.json found - creating one from config.example.json"
  run cp "$SOURCE_CONFIG" "$TARGET_DIR/config.json"
fi

if [ "$DRY_RUN" -eq 0 ]; then
  if ! cmp -s "$SOURCE_EXTENSION" "$TARGET_DIR/index.ts"; then
    echo "error: installed index.ts does not match the source" >&2
    exit 1
  fi
  echo
  echo "Verified: the installed index.ts matches the repository copy."
fi

echo
echo "Done."
echo
echo "Next steps:"
echo "  1. Restart ThinkRail (or reload the session) so the extension is re-imported."
echo "  2. In any chat, run:  /agent-models"
echo "  3. To edit pins by hand:  $TARGET_DIR/config.json"
if [ -n "$BACKUP_PATH" ]; then
  echo
  echo "Roll back the code with:  cp \"$BACKUP_PATH\" \"$TARGET_DIR/index.ts\""
fi
