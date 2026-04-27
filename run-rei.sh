#!/bin/bash

# Cargar variables del .env automáticamente (como OPENROUTER_API_KEY) si el archivo existe
if [ -f .env ]; then
  # Ignora comentarios y carga las variables exportándolas al entorno
  export $(grep -v '^#' .env | xargs)
fi

# Configuración del modelo (usará valores del .env si existen, sino usa defaults)
export MODEL_PROVIDER="${MODEL_PROVIDER:-openrouter}"
export OPENROUTER_MODEL="${OPENROUTER_MODEL:-nvidia/nemotron-3-super-120b-a12b:free}"

# Usamos un directorio temporal local por si la Mac tiene bloqueado el /var/folders/T
export TMPDIR="$PWD/.tmp"
mkdir -p "$TMPDIR"

# Iniciar la CLI
echo "Iniciando REI con modelo: $OPENROUTER_MODEL"
npm run dev -- chat
