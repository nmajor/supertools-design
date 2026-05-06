#!/usr/bin/env bash
#
# Bootstrap a new Design OS + supertools-design project.
#
# Usage:
#   ./install.sh <project-name>
#
# Or one-liner:
#   curl -fsSL https://raw.githubusercontent.com/nmajor/supertools-design/main/install.sh | bash -s <project-name>
#
# Creates ./<project-name>-design/ containing:
#   - A clone of Design OS (the React planning app + design-os slash commands)
#   - A vendored copy of supertools-design at .supertools/
#   - Symlinks under .claude/commands/ and .claude/skills/ wiring supertools
#     into Claude Code so /supertools-design:* commands are immediately available.

set -euo pipefail

DESIGN_OS_REPO="${DESIGN_OS_REPO:-https://github.com/buildermethods/design-os.git}"
SUPERTOOLS_REPO="${SUPERTOOLS_REPO:-https://github.com/nmajor/supertools-design.git}"

usage() {
  cat <<EOF
Usage: install.sh <project-name>

Creates ./<project-name>-design/ with Design OS cloned and supertools-design
wired into .claude/.

Environment overrides:
  DESIGN_OS_REPO    (default: $DESIGN_OS_REPO)
  SUPERTOOLS_REPO   (default: $SUPERTOOLS_REPO)
EOF
}

if [ "${1:-}" = "" ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 1
fi

NAME="$1"
DIR="${NAME}-design"

if [ -e "$DIR" ]; then
  echo "Error: $DIR already exists." >&2
  exit 1
fi

for cmd in git ln; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is required but not installed." >&2
    exit 1
  fi
done

echo "[1/4] Cloning Design OS into $DIR/"
git clone --depth 1 "$DESIGN_OS_REPO" "$DIR"
cd "$DIR"
rm -rf .git

echo "[2/4] Vendoring supertools-design into .supertools/"
git clone --depth 1 "$SUPERTOOLS_REPO" .supertools
rm -rf .supertools/.git

echo "[3/4] Wiring supertools-design into .claude/"
mkdir -p .claude/commands .claude/skills
ln -s ../../.supertools/commands .claude/commands/supertools-design
ln -s ../../.supertools/skills .claude/skills/supertools-design

echo "[4/4] Initializing fresh git repo"
git init -q -b main
git add -A
git commit -q -m "Bootstrap from Design OS + supertools-design"

cat <<EOF

Done. Project created at ./$DIR/

  cd $DIR
  claude

In Claude, get started with:
  /product-vision               (Design OS — define product, roadmap, data shape)
  /supertools-design:start      (Supertools — initialize the post-Design-OS flow)

To update supertools-design later:
  rm -rf .supertools && git clone --depth 1 $SUPERTOOLS_REPO .supertools && rm -rf .supertools/.git

EOF
