#!/bin/bash
# Local installer for REI CLI using the current working copy
set -e

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.rei"
BIN_DIR="$HOME/.local/bin"

mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"

echo "Installing REI CLI from local source: $SOURCE_DIR"
echo "Target install dir: $INSTALL_DIR"

# Stamp the build BEFORE syncing: this directory is a checkout, ~/.rei is not (the rsync below
# drops .git), so this is the only moment the commit can be read. Without it `rei --version` can
# only ever report the package version, and telling two machines' builds apart means grepping dist/.
node "$SOURCE_DIR/scripts/write-build-info.js" || echo "(could not stamp the build — --version will say unknown)"

# Sync current repository contents into ~/.rei (without heavyweight or local-only folders)
# `.env` is excluded from BOTH sides of --delete: it is the machine's own file (API keys, endpoints)
# and lives only in the install dir. Without the exclude, --delete removed it on every install,
# because a fresh clone has no .env to replace it with. The cp fallback below always preserved it.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude ".git" \
    --exclude ".env" \
    --exclude "node_modules" \
    --exclude "dist" \
    --exclude ".rei" \
    --exclude "bin/github-mcp-server" \
    "$SOURCE_DIR/" "$INSTALL_DIR/"
else
  echo "rsync not found, using cp fallback"
  if [ -d "$INSTALL_DIR" ]; then
    find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name "bin" ! -name ".env" ! -name "sessions" -exec rm -rf {} +
    if [ -d "$INSTALL_DIR/bin" ]; then
      find "$INSTALL_DIR/bin" -mindepth 1 ! -name "github-mcp-server" -exec rm -rf {} +
    fi
  fi
  cp -R "$SOURCE_DIR"/* "$INSTALL_DIR"/
  if [ -f "$SOURCE_DIR/.env" ]; then
    cp "$SOURCE_DIR/.env" "$INSTALL_DIR/.env"
  fi
fi

cd "$INSTALL_DIR"
npm install
npm run build

# Create global .env example only if missing
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cat > "$INSTALL_DIR/.env" << EENV
# API Keys (fill based on your provider)
OPENROUTER_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=
HF_TOKEN=

# REI configuration
REI_WORKSPACE_PATH=
MODEL_PROVIDER=openrouter
OPENROUTER_MODEL=qwen/qwen3-coder-30b-a3b-instruct
ALLOWED_WORKSPACES=
EENV
fi

# Create global 'rei' launcher script in ~/.local/bin
cat > "$BIN_DIR/rei" << 'EOF'
#!/bin/bash
# Load global ~/.rei/.env first, then local .env (filtering placeholders)
# is_machine_scoped KEY — mirrors INSTALL_SCOPED in src/load-env.ts. The install's .env describes
# the MACHINE (credentials, where a backend listens, which backend exists); models, sampling,
# context and REI_* behaviour are per-project. Exporting the whole install file made every one of
# those a shell variable, and a shell variable beats both .env files — so a fresh project silently
# inherited another project's model. Keep this list in step with load-env.ts.
is_machine_scoped() {
  case "$1" in
    *_API_KEY|*_TOKEN|*_SECRET|*_CLIENT_ID|*_BASE_URL|*_REQUEST_TIMEOUT_MS) return 0 ;;
    MODEL_PROVIDER|AGENT_MODEL_PROVIDER|ALLOWED_WORKSPACES) return 0 ;;
    *) return 1 ;;
  esac
}

# load_env_file FILE [machine]
#   machine → export only machine-scoped keys (used for the install's ~/.rei/.env)
#   omitted → export everything (the project's own file)
load_env_file() {
  local env_file="$1"
  local scope="${2:-all}"
  while IFS= read -r line; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    local key="${line%%=*}"
    local val="${line#*=}"
    val="${val%\"}"
    val="${val#\"}"
    val="${val%\'}"
    val="${val#\'}"
    # Strip inline comments (" #...") + trailing whitespace, matching dotenv. Without this,
    # "KEY=value  # note" exports the comment as part of the value — silently breaking string
    # vars like REI_REASONING_EFFORT_AGENT (numeric vars survive via parseInt). dotenv strips
    # them in node, but this wrapper exports the var FIRST and dotenv won't override it.
    val="${val%%[[:space:]]#*}"
    val="${val%"${val##*[![:space:]]}"}"

    if [[ "$val" == *"_here"* || "$val" == "your_"* || "$val" == *"placeholder"* || -z "$val" ]]; then
      continue
    fi
    if [ "$scope" = "machine" ] && ! is_machine_scoped "$key"; then
      continue
    fi
    export "$key=$val"
  done < "$env_file"
}

# Check if --config or --help flags were passed
want_config=0
want_help=0
for arg in "$@"; do
  if [ "$arg" = "--config" ]; then
    want_config=1
  elif [ "$arg" = "--help" ] || [ "$arg" = "-h" ] || [ "$arg" = "help" ]; then
    want_help=1
  fi
done

if [ "$want_help" -eq 1 ]; then
  echo "██████╗ ███████╗██╗"
  echo "██╔══██╗██╔════╝██║"
  echo "██████╔╝█████╗  ██║"
  echo "██╔══██╗██╔══╝  ██║"
  echo "██║  ██║███████╗██║"
  echo "╚═╝  ╚═╝╚══════╝╚═╝"
  echo ""
  # The CLI owns the command list — printing a second copy here is how the two drifted apart.
  node "$HOME/.rei/bin/rei.js" --help
  exit 0
fi

# Resolve configuration. The install file supplies ONLY machine-scoped keys; the project's own
# file supplies everything else. `env_exists` asks "is this project configured?", so the install's
# keys alone do not answer it — a machine with API keys but a brand-new project still needs setup.
[ -f "$HOME/.rei/.env" ] && load_env_file "$HOME/.rei/.env" machine

# Canonical per-project location is .rei/.env; a root .env is the legacy one and still honoured.
project_env=""
if [ -f .rei/.env ]; then
  project_env=".rei/.env"
elif [ -f .env ]; then
  project_env=".env"
fi

env_exists=0
if [ -n "$project_env" ]; then
  env_exists=1
  load_env_file "$project_env"
fi

# Force local TMPDIR to avoid permission issues
export TMPDIR="$HOME/.tmp"
mkdir -p "$TMPDIR"

if [ "$want_config" -eq 1 ]; then
  echo "🔄 Starting interactive configuration wizard..."
  node "$HOME/.rei/scripts/launch-rei.js"
elif [ "$env_exists" -eq 0 ]; then
  echo "🔄 No configuration found — starting setup wizard..."
  node "$HOME/.rei/scripts/launch-rei.js"
elif node "$HOME/.rei/scripts/launch-rei.js" --preflight; then
  # Preflight passed (may have just saved a new API key) — reload env so the launch sees it.
  [ -f "$HOME/.rei/.env" ] && load_env_file "$HOME/.rei/.env" machine
  [ -n "$project_env" ] && load_env_file "$project_env"
  # Pass the subcommand through. This used to hardcode `chat`, so `rei ask|plan|agent "<task>"`
  # — the one-shots the help and the README both advertise — silently opened an interactive
  # session instead (and failed outright when piped, with no TTY).
  case "${1:-}" in
    ask|plan|agent|chat) REI_CMD="" ;;
    *) REI_CMD="chat" ;;
  esac
  REI_WORKSPACE_PATH="${REI_WORKSPACE_PATH:-"$(pwd)"}" node "$HOME/.rei/bin/rei.js" ${REI_CMD} "$@"
else
  echo "🔄 Launching setup wizard to finish configuration..."
  node "$HOME/.rei/scripts/launch-rei.js"
fi
EOF

chmod +x "$BIN_DIR/rei"

echo "REI CLI installed from local source. Run 'rei' in any folder."
