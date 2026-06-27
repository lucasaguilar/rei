# How Context Was Generated — Ask, Planning & Agent

Resumen técnico de cómo se construye y envía el contexto en cada modo de sesión (`ask`, `planning`, `agent`), basado en el código fuente actual de `rei`.

---

## 1. Flujo General de Construcción de Contexto

```
buildTurnContext()  →  TurnContext  →  buildMessagesForModel()  →  ChatMessage[]  →  API Provider
```

Ambas etapas (contexto estático + mensajes) se ejecutan en paralelo o secuencial según el modo:

| Paso | Archivo | Función | Descripción |
|------|---------|---------|-------------|
| 1 | `workspace-scanner.ts` | `scanWorkspace()` | Escanea workspace → `FileMeta[]` (máx 2000 archivos) |
| 2 | `context-builder.helpers.ts` | `buildRepoSummary()` | Detecta project markers + top-level dirs + file count |
| 3 | `rag-indexer.ts` | `searchRag()` | Búsqueda semántica vectorial (si `ENABLE_SEMANTIC_RAG_SEARCH=true`) |
| 4 | `file-selector.ts` | `selectRelevantFiles()` | Selección heurística de archivos relevantes por score |
| 5 | `context-builder.helpers.ts` | `buildCallerFilesContext()` | Caller graph (solo si `CHANGE_INTENT_PATTERN` coincide) |
| 6 | `context-builder.ts` | `buildTurnContext()` | Ensambla `TurnContext` completo |
| 7 | `context-budget.ts` | `calculateContextBudget()` + `trimContextToBudget()` | Calcula y recorta al budget de tokens |
| 8 | `message-builder.ts` | `buildMessagesForModel()` | Construye array de mensajes para la API |

---

## 2. Tabla Comparativa por Modo

### 2.1 Selección de Archivos Relevantes

| Parámetro | `ask` | `planning` | `agent` |
|-----------|-------|------------|---------|
| **Máx. archivos relevantes** | 2 | 2 | 3 |
| **Archivos inyectados por defecto** | ❌ (on-demand) | ❌ (on-demand) | ✅ (proactivo) |
| **Preview por archivo** | 300 chars (default) | 300 chars (default) | 800 chars (agent) |
| **Fallback si no hay match** | `README.md`, `package.json`, `tsconfig.json` | Ningún fallback explícito | Ningún fallback explícito |
| **Boost para docs/package.json** | No | ✅ (+2 pts) | No |
| **RAG score mínimo para preview** | 0.4 | 0.4 | 0.4 |

**Detalle de `isOnDemandFileContextEnabled(mode)`:**
- `ask` → `true` (por defecto): archivos solo se inyectan si el usuario los menciona explícitamente o usa keywords de código completo.
- `planning` → `true` (por defecto): mismo comportamiento que ask.
- `agent` → `false` (por defecto): archivos se inyectan proactivamente en cada turno.

### 2.2 Mensajes de Historial (Ventana de Contexto)

| Parámetro | `ask` | `planning` | `agent` |
|-----------|-------|------------|---------|
| **Máx. mensajes no-system** | 20 (~40 intercambios) | 12 (~24 intercambios) | 16 (~32 intercambios) |
| **Compresión de turns antiguos** | Compacta user turns en `[Previous user request: ...]` | Compacta user turns en `[Previous user request: ...]` | Compacta user turns en `[Previous user request: ...]` |
| **Mensajes assistant sin tags XML** | Se preservan | Se preservan | Se reemplazan por `[Previous response — different mode]` |
| **Format reminder al final** | ❌ | ❌ | ✅ (append al último user message) |
| **Alternancia de roles** | ✅ | ✅ | ✅ |

### 2.3 Componentes del Contexto Inyectado

| Componente | `ask` | `planning` | `agent` |
|------------|-------|------------|---------|
| **System prompt** | `prompts/modes/ask.md` + `prompts/shared/base.md` + `personality.md` + `response-rules.md` | `prompts/modes/planning.md` + `prompts/shared/base.md` + `personality.md` + `response-rules.md` | `prompts/modes/agent.md` + `prompts/shared/base.md` + `personality.md` + `response-rules.md` |
| **Format prompt** | `prompts/formats/ask-format.md` | `prompts/formats/planning-format.md` | `prompts/formats/agent-format.md` + tools/wholefile |
| **Repo Summary** | ✅ (project markers + dirs + file count) | ✅ (idéntico) | ✅ (idéntico) |
| **RAG Node Snippets** | ✅ (si index existe) | ✅ (si index existe) | ✅ (si index existe) |
| **File Previews** | ❌ (on-demand) | ❌ (on-demand) | ✅ (proactivo, 800 chars) |
| **Caller Files** | ✅ (si change intent) | ✅ (si change intent) | ✅ (si change intent) |
| **External Knowledge** | ✅ (si orchestrator configurado) | ✅ (si orchestrator configurado) | ✅ (si orchestrator configurado) |
| **Explicit path hints** | ✅ (boost +30 si match exacto) | ✅ (boost +30 si match exacto) | ✅ (boost +30 si match exacto) |

### 2.4 Prompts por Modo (Tamaños)

| Prompt | `ask` | `planning` | `agent` |
|--------|-------|------------|---------|
| **Mode prompt** | 4.3K | 5.1K | 11.6K |
| **Format prompt** | 734B | 1.4K | 1K–3.9K (según formato) |
| **Skills disponibles** | `angular-component-refactor`, `create-pr` | `angular-component-refactor`, `create-pr`, `write-spec`, `write-tests`, `micro-task-decomposition` | `angular-component-refactor`, `create-pr`, `write-spec`, `write-tests`, `micro-task-decomposition` |

### 2.5 Presupuesto de Tokens (Dinámico)

El budget se calcula en `context-budget.ts`:

```
budget = numCtx - systemPrompt - history - userInput - responseReserve - toolsTokens - 2000 (repoMap) - 600 (overhead)
```

| Aspecto | `ask` | `planning` | `agent` |
|---------|-------|------------|---------|
| **Archivos máx. inyectados** | 2 | 2 | 3 |
| **Caracteres por preview** | 300 | 300 | 800 |
| **Caller files máx.** | 1 | 1 | 1 |
| **RAG snippets máx.** | 4 | 4 | 4 |
| **Historial máximo** | 20 turns | 12 turns | 16 turns |
| **Orden de recorte (si excede budget)** | 1. External knowledge → 2. Caller files → 3. RAG snippets → 4. Relevant files → 5. Truncar previews → 6. Solo repo summary | (idéntico) | (idéntico) |

---

## 3. Diagrama de Flujo por Modo

### `ask` (Solo Lectura / Consultas)
```
User Input
  ├─ scanWorkspace() → FileMeta[] (máx 2000)
  ├─ buildRepoSummary() → "Project markers: ..."
  ├─ searchRag() → RagSearchResult[] (si index existe)
  ├─ selectRelevantFiles() → 2 archivos máx (score > 0)
  │   └─ isOnDemandFileContextEnabled("ask") = true → NO se inyectan previews
  ├─ buildCallerFilesContext() → solo si CHANGE_INTENT_PATTERN
  ├─ buildTurnContext() → TurnContext (sin file previews)
  ├─ buildMessagesForModel() → 20 mensajes máx
  └─ API: system(ask.md) + history + user (sin archivos)
```

### `planning` (Generación de Planes)
```
User Input
  ├─ scanWorkspace() → FileMeta[] (máx 2000)
  ├─ buildRepoSummary() → "Project markers: ..."
  ├─ searchRag() → RagSearchResult[] (si index existe)
  ├─ selectRelevantFiles() → 2 archivos máx (score > 0)
  │   └─ isOnDemandFileContextEnabled("planning") = true → NO se inyectan previews
  │   └─ Boost: README.md +2, package.json +2
  ├─ buildCallerFilesContext() → solo si CHANGE_INTENT_PATTERN
  ├─ buildTurnContext() → TurnContext (sin file previews)
  ├─ buildMessagesForModel() → 12 mensajes máx
  └─ API: system(planning.md) + history + user (sin archivos)
```

### `agent` (Ejecución de Tareas)
```
User Input
  ├─ scanWorkspace() → FileMeta[] (máx 2000)
  ├─ buildRepoSummary() → "Project markers: ..."
  ├─ searchRag() → RagSearchResult[] (si index existe)
  ├─ selectRelevantFiles() → 3 archivos máx (score > 0)
  │   └─ isOnDemandFileContextEnabled("agent") = false → SÍ se inyectan previews (800 chars)
  ├─ buildCallerFilesContext() → si CHANGE_INTENT_PATTERN (1 caller file)
  ├─ buildTurnContext() → TurnContext (con file previews + caller files)
  ├─ calculateContextBudget() → tokenBudget dinámico
  ├─ trimContextToBudget() → recorte progresivo si excede
  ├─ buildMessagesForModel() → 16 mensajes máx
  │   └─ isNonAgentAssistantMessage() → reemplaza respuestas de otros modos
  │   └─ appendAgentReminder() → format reminder al último user message
  └─ API: system(agent.md) + history + user (con archivos + caller + RAG)
```

---

## 4. Resumen de Diferencias Clave

| Aspecto | `ask` | `planning` | `agent` |
|---------|-------|------------|---------|
| **Filosofía** | Ligero, solo lectura | Ligero, orientado a docs | Pesado, proactivo, con código |
| **Archivos inyectados** | Solo explícitos | Solo explícitos | 3 archivos + previews (800 chars) |
| **Caller graph** | ✅ (si change intent) | ✅ (si change intent) | ✅ (si change intent) |
| **RAG snippets** | ✅ (si index) | ✅ (si index) | ✅ (si index) |
| **Historial** | 20 turns | 12 turns | 16 turns |
| **Compresión assistant** | Preservado | Preservado | Reemplazado si no tiene tags XML |
| **Format reminder** | No | No | Sí (al final del último user msg) |
| **Prompt system** | 4.3K | 5.1K | 11.6K |
| **Uso de tokens** | Bajo | Medio | Alto |

---

## 5. Variables de Entorno que Afectan el Contexto

| Variable | Efecto |
|----------|--------|
| `REI_ON_DEMAND_FILE_CONTEXT` | Override global de `isOnDemandFileContextEnabled()` |
| `REI_ON_DEMAND_FILE_CONTEXT_ASK` | Override específico para modo `ask` |
| `REI_ON_DEMAND_FILE_CONTEXT_PLANNING` | Override específico para modo `planning` |
| `REI_ON_DEMAND_FILE_CONTEXT_AGENT` | Override específico para modo `agent` |
| `ENABLE_SEMANTIC_RAG_SEARCH` | Activa/desactiva búsqueda RAG vectorial (default: `true`) |
| `REI_PRESERVE_THINKING` | Preserva `reasoning_content` de modelos de razonamiento |

---

*Generado a partir del código fuente de `rei` — `src/context/`, `src/chat/`, `src/workspace/`, `prompts/modes/`, `prompts/formats/`.*
