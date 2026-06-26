#!/bin/bash
# Global installer for REI Server (API mode)
set -e

INSTALL_DIR="$HOME/.rei"
BIN_DIR="$HOME/.local/bin"

mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"

echo "📁 Installing REI Server into $INSTALL_DIR with symlink in $BIN_DIR"

# Clone the official REI repository
if [ ! -d "$INSTALL_DIR/.git" ]; then
  git clone https://github.com/lucasaguilar/rei.git "$INSTALL_DIR"
else
  echo "Repository already cloned at $INSTALL_DIR, updating..."
  cd "$INSTALL_DIR"
  git pull
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

# Create global 'rei-server' launcher script in ~/.local/bin
cat > "$BIN_DIR/rei-server" << 'EOF'
#!/bin/bash
# Load global ~/.rei/.env first, then local .env (filtering placeholders)
load_env_file() {
  local env_file="$1"
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
    export "$key=$val"
  done < "$env_file"
}

# Check if .env files exist
env_exists=0
if [ -f "$HOME/.rei/.env" ]; then
  env_exists=1
  load_env_file "$HOME/.rei/.env"
fi

if [ -f .env ]; then
  env_exists=1
  load_env_file .env
fi

# Force local TMPDIR to avoid permission issues
export TMPDIR="$HOME/.tmp"
mkdir -p "$TMPDIR"

REI_WORKSPACE_PATH="${REI_WORKSPACE_PATH:-"$(pwd)"}" node "$HOME/.rei/dist/server.js" "$@"
EOF

chmod +x "$BIN_DIR/rei-server"
echo "✅ REI Server installed. Run 'rei-server' in any folder."