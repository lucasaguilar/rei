#!/bin/bash

# Script de instalación de REI para uso con Continue
# Este script permite instalar REI como servidor local para integración con VS Code

set -e  # Salir en caso de error

echo "🚀 Instalando REI (Repository-Aware AI)..."
echo "=========================================="

# 1. Verificar Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js no encontrado. Por favor instala Node.js (v18+) primero."
    exit 1
fi

NODE_VERSION=$(node --version)
echo "✅ Node.js versión: $NODE_VERSION"

# 2. Verificar npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm no encontrado. Por favor instala npm primero."
    exit 1
fi

# 3. Crear directorio de instalación (si no existe)
INSTALL_DIR="$HOME/.rei"
mkdir -p "$INSTALL_DIR"
echo "📁 Directorio de instalación: $INSTALL_DIR"

# 4. Clonar o copiar el repositorio (simulación)
# En producción, esto sería un git clone o descarga desde npm
echo "📋 Copiando archivos de REI..."
# Aquí iría la lógica real de clonado o copia
# Por ahora simulamos con una copia local

# 5. Instalar dependencias
echo "📦 Instalando dependencias..."
cd "$INSTALL_DIR"
npm install

# 6. Crear script de ejecución
cat > "$INSTALL_DIR/rei-server" << 'EOF'
#!/bin/bash
# Script para ejecutar el servidor REI

# Configurar variables de entorno
export REI_SERVER_PORT=3000
export REI_WORKSPACE_PATH="$PWD"

# Ejecutar el servidor
echo "🚀 Iniciando servidor REI en puerto $REI_SERVER_PORT"
echo "📁 Workspace: $REI_WORKSPACE_PATH"
node "$INSTALL_DIR/src/server.ts"
EOF

chmod +x "$INSTALL_DIR/rei-server"

# 7. Crear archivo de configuración de ejemplo
cat > "$INSTALL_DIR/.rei-config.json" << 'EOF'
{
  "allowedWorkspaces": [
    "/Users/lucasaguilar/www/lab/rei",
    "/Users/lucasaguilar/www/projects"
  ],
  "defaultModel": "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "serverPort": 3000
}
EOF

echo "✅ Instalación completada!"
echo ""
echo "🔧 Para usar REI con Continue:"
echo "   1. Ejecuta: $INSTALL_DIR/rei-server"
echo "   2. En VS Code, configura Continue con:"
echo "      Endpoint: http://localhost:3000/chat/completions"
echo "      Model: openrouter/nvidia/nemotron-3-super-120b-a12b:free"
echo ""
echo "📝 Configuración adicional:"
echo "   - Puedes modificar .rei-config.json para permitir otros workspaces"
echo "   - El servidor escucha en http://localhost:3000"
echo ""
echo "💡 Recomendación: Usa 'npm run server' desde el directorio del proyecto"
echo "   para mantener el flujo de sesiones y contexto de REI."