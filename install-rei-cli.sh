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

if [ -f .env ]; then
	load_env_file .env
elif [ -f "$HOME/.rei/.env" ]; then
	load_env_file "$HOME/.rei/.env"
fi
# Forzar TMPDIR local para evitar problemas de permisos
export TMPDIR="$HOME/.tmp"
mkdir -p "$TMPDIR"
REI_WORKSPACE_PATH="${REI_WORKSPACE_PATH:-"$(pwd)"}" node "$HOME/.rei/bin/rei.js" chat "$@"
EOF
chmod +x "$BIN_DIR/rei"
echo "✅ REI CLI instalado. Ejecuta 'rei' en cualquier carpeta."