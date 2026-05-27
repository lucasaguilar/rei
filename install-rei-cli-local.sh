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

# Sync current repository contents into ~/.rei (without heavyweight or local-only folders)
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude ".git" \
    --exclude "node_modules" \
    --exclude "dist" \
    --exclude ".rei" \
    "$SOURCE_DIR/" "$INSTALL_DIR/"
else
  echo "rsync not found, using cp fallback"
  rm -rf "$INSTALL_DIR"/*
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
# Load local .env first, fallback to global ~/.rei/.env
load_env_file() {
  local env_file="$1"
  while IFS= read -r line; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    export "$line"
  done < "$env_file"
}

# Ver si se pasó el flag --config o --help
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
  echo "REI — Just REI (Sniper-Precision Coding Agent)"
  echo ""
  echo "Usage:"
  echo "  rei                         Start the interactive terminal CLI (chat/ask mode)"
  echo "  rei chat                    Start the interactive terminal CLI (chat/ask mode)"
  echo "  rei plan \"<task>\"           Run a one-shot planning task"
  echo ""
  echo "Configuration:"
  echo "  rei --config                Launch the interactive configuration wizard"
  echo ""
  echo "Global Options:"
  echo "  --workspace <path>          Target project directory (defaults to current directory)"
  echo "  --help, -h                  Show this help text"
  exit 0
fi

# Ver si existen archivos .env
env_exists=0
if [ -f .env ]; then
  env_exists=1
  load_env_file .env
elif [ -f "$HOME/.rei/.env" ]; then
  env_exists=1
  load_env_file "$HOME/.rei/.env"
fi

# Force local TMPDIR to avoid permission issues
export TMPDIR="$HOME/.tmp"
mkdir -p "$TMPDIR"

if [ "$want_config" -eq 1 ] || [ "$env_exists" -eq 0 ]; then
  echo "🔄 Starting interactive configuration wizard..."
  node "$HOME/.rei/scripts/launch-rei.js"
else
  REI_WORKSPACE_PATH="${REI_WORKSPACE_PATH:-"$(pwd)"}" node "$HOME/.rei/bin/rei.js" chat "$@"
fi
EOF

chmod +x "$BIN_DIR/rei"

echo "REI CLI installed from local source. Run 'rei' in any folder."
