#!/bin/bash
# Instalador para REI CLI global
set -e
INSTALL_DIR="$HOME/.rei"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"
echo "📁 Instalando REI CLI en $INSTALL_DIR y symlink en $BIN_DIR"
# Clonar el repo oficial de REI
if [ ! -d "$INSTALL_DIR/.git" ]; then
	git clone git@github.com:lucasaguilar/rei.git "$INSTALL_DIR"
else
	echo "Repositorio ya clonado en $INSTALL_DIR, actualizando..."
	cd "$INSTALL_DIR"
	git pull
fi
cd "$INSTALL_DIR"
npm install
npm run build
# Crear .env global de ejemplo si no existe
if [ ! -f "$INSTALL_DIR/.env" ]; then
	cat > "$INSTALL_DIR/.env" << EENV
# API Keys (completa según tu proveedor)
OPENROUTER_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=
HF_TOKEN=

# Configuración de REI
REI_WORKSPACE_PATH=
MODEL_PROVIDER=openrouter
OPENROUTER_MODEL=qwen/qwen3-coder-30b-a3b-instruct
ALLOWED_WORKSPACES=
EENV
fi

# Crear script global 'rei' en ~/.local/bin
cat > "$BIN_DIR/rei" << 'EOF'
#!/bin/bash
# Cargar .env local o global (solo lineas KEY=VALUE validas)
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

# Forzar TMPDIR local para evitar problemas de permisos
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
echo "✅ REI CLI instalado. Ejecuta 'rei' en cualquier carpeta."