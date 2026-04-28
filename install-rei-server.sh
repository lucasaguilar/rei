#!/bin/bash
# Instalador para REI Server (API)
set -e
INSTALL_DIR="$HOME/.rei"
mkdir -p "$INSTALL_DIR"
echo "📁 Instalando REI Server en $INSTALL_DIR"
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

# Crear script ejecutable rei-server en $INSTALL_DIR
cat > "$INSTALL_DIR/rei-server" << 'EOF'
#!/bin/bash
# Cargar .env local o global
if [ -f .env ]; then
	export $(grep -v '^#' .env | xargs)
elif [ -f "$HOME/.rei/.env" ]; then
	export $(grep -v '^#' "$HOME/.rei/.env" | xargs)
fi
# Forzar TMPDIR local para evitar problemas de permisos
export TMPDIR="$HOME/.tmp"
mkdir -p "$TMPDIR"
REI_WORKSPACE_PATH="${REI_WORKSPACE_PATH:-"$(pwd)"}" npx tsx "$HOME/.rei/src/server.ts" "$@"
EOF
chmod +x "$INSTALL_DIR/rei-server"
echo "✅ REI Server instalado. Ejecuta: $INSTALL_DIR/rei-server"