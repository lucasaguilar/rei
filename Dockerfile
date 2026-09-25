# REI — multi-stage build for Render (Web Service)
# Entrypoint real: dist/server.js (script "server"). Expone un endpoint
# OpenAI-compatible en /v1/chat/completions y /models.

# Base glibc (Debian), NO alpine: onnxruntime-node (vía transformers) trae binarios linkeados
# contra glibc y en musl el server muere al arrancar con "Error loading shared library ld-linux".
# Las tres etapas usan la misma base para que `npm ci` baje los binarios nativos correctos.

# ETAPA 1: Dependencias
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ETAPA 2: Compilación
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ETAPA 3: Runtime
FROM node:22-bookworm-slim AS runner
WORKDIR /app
# REI_SERVER_HOST: la plataforma (Render, Fly) solo enruta tráfico a un proceso que escuche en
# 0.0.0.0; el default del server es 127.0.0.1 justamente para NO exponerse por accidente. Al
# abrirlo acá, server.ts exige REI_SERVER_TOKEN y se niega a arrancar sin él — a propósito: lo que
# queda expuesto es un agente que edita archivos y ejecuta comandos. El token se setea en el
# entorno del servicio (ver render.yaml), nunca acá.
ENV NODE_ENV=production \
    REI_WORKSPACE_PATH=/app \
    ALLOWED_WORKSPACES=/app \
    REI_SERVER_HOST=0.0.0.0 \
    REI_SERVER_PORT=3000

# node_modules completo (incluye las dependencias nativas sharp/esbuild/transformers
# con sus binarios linux-x64). No se hace `npm prune --production` para no arrancar
# las dependencias opcionales por plataforma que sharp necesita en runtime.
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/package.json ./
# Assets de runtime fuera de dist/: los loaders resuelven <root>/prompts (prompts, skills, roles)
# y <root>/templates/rules desde import.meta.url. Sin esto /healthz queda verde pero el primer
# turno de chat falla al cargar el system prompt.
COPY --chown=node:node --from=builder /app/prompts ./prompts
COPY --chown=node:node --from=builder /app/templates ./templates

# /app es el workspace (REI_WORKSPACE_PATH) y REI escribe ahí .rei/ (logs, sesiones); WORKDIR lo
# crea como root, así que sin esto el server muere con EACCES en mkdir /app/.rei/logs.
RUN chown node:node /app

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
