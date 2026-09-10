#!/usr/bin/env bash
# One-command install:
#
#   curl -fsSL https://raw.githubusercontent.com/lucasaguilar/rei/main/install.sh | bash
#
# Clones (or updates) the repo into ~/.rei-src, builds it, and runs the CLI installer. Everything it
# does is visible above — piping a script into a shell is worth reading first, and this one is short
# on purpose.
set -euo pipefail

REPO="${REI_REPO:-https://github.com/lucasaguilar/rei.git}"
# A TEMPORARY clone, removed at the end. `install-rei-cli-local.sh` rsyncs the source into ~/.rei
# and installs dependencies there, so keeping the clone too would leave two copies and two
# node_modules — about 1.6 GB for a CLI. Set REI_SRC to keep it somewhere for development.
SRC="${REI_SRC:-$(mktemp -d)/rei}"
KEEP_SRC="${REI_SRC:+yes}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "❌ $1 is required and was not found."; exit 1; }; }
need git
need node
need npm

# Node 20+ — REI is ESM and uses modern APIs; an older runtime fails in ways that do not name the
# version as the cause.
major=$(node -p "process.versions.node.split('.')[0]")
if [ "$major" -lt 20 ]; then
  echo "❌ Node 20 or newer is required (found $(node --version))."
  exit 1
fi

if [ -d "$SRC/.git" ]; then
  echo "→ Updating $SRC"
  git -C "$SRC" pull --ff-only
else
  echo "→ Cloning into $SRC"
  git clone --depth 1 "$REPO" "$SRC"
fi

cd "$SRC"
echo "→ Installing dependencies"
npm ci --silent || npm install --silent

echo "→ Building"
npm run build --silent

echo "→ Installing the rei command"
bash ./install-rei-cli-local.sh

if [ -z "$KEEP_SRC" ]; then
  cd "$HOME"
  rm -rf "$(dirname "$SRC")"
fi

cat <<'DONE'

✅ Done.

   cd <your project>
   rei                 first run has no config, so the setup wizard starts by itself
   rei --config        change it later
DONE
