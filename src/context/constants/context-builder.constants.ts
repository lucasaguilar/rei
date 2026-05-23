// Archivos insignia del proyecto que identifican el ecosistema (Node, Rust, Go, Python, etc.) para aplicar reglas específicas.
export const PROJECT_MARKERS = [
  "package.json",
  "tsconfig.json",
  "angular.json",
  "README.md",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
];

// Expresión regular para detectar si el usuario exige explícitamente ver el código completo o exacto de un archivo.
// Si coincide, REI evita compresión y envía el archivo de manera íntegra.
export const EXPLICIT_CONTENT_REQUEST_PATTERN =
  /c[oó]digo exacto|exact code|full code|complete code|contenido completo|c[oó]digo completo|full content|complete file|todas las funciones|all functions|show.{0,15}code|mostrame.{0,25}c[oó]digo|dame.{0,25}c[oó]digo/;

// Expresión regular para identificar si la consulta del usuario implica intención de modificar o escribir código.
// Si coincide, REI activará la búsqueda de dependencias y el análisis del grafo de llamadas (Caller Graph).
export const CHANGE_INTENT_PATTERN =
  /\b(add|change|modify|update|fix|implement|create|remove|delete|refactor|agreg|cambi|modific|actualiz|arregl|implement|cre[ar]|elimin|borr)\w*/i;

// Cantidad máxima de referencias de símbolos a buscar en el Grafo de Llamadas antes de ordenarlas y filtrarlas.
export const MAX_CALLER_SEARCH_RESULTS = 15;

// Cantidad máxima de archivos llamadores (dependencias directas) a inyectar en el contexto para cambios coordinados.
export const MAX_CALLER_CONTEXT_FILES = 1;

// Límite máximo de caracteres por fragmento de código (nodo AST) extraído desde la búsqueda semántica vectorial (RAG).
export const MAX_RAG_NODE_SNIPPET_CHARS = 1000;

// Interruptor general para activar o desactivar por completo la búsqueda semántica RAG mediante embeddings locales.
export const ENABLE_SEMANTIC_RAG_SEARCH = true;

// Cantidad máxima de archivos sospechosos de ser relevantes a seleccionar por heurística en modo "agent".
export const MAX_RELEVANT_FILES_AGENT = 3;

// Cantidad máxima de archivos sospechosos de ser relevantes a seleccionar por heurística en modos no-agente ("ask" o "planning").
export const MAX_RELEVANT_FILES_NON_AGENT = 2;

// Puntaje mínimo de similitud de coseno en la búsqueda RAG requerido para calificar una vista previa de archivo a ser inyectada.
export const MIN_RAG_SCORE_FOR_FILE_PREVIEW = 0.4;

// Determina si los archivos solo se inyectan al contexto bajo demanda explícita del usuario, configurable por modo.
// Soporta variables específicas: REI_ON_DEMAND_FILE_CONTEXT_ASK, REI_ON_DEMAND_FILE_CONTEXT_AGENT, etc.
// Si no están definidas, cae de vuelta a la general o a valores inteligentes predeterminados.
export function isOnDemandFileContextEnabled(mode: string): boolean {
  const envKey = `REI_ON_DEMAND_FILE_CONTEXT_${mode.toUpperCase()}`;
  const specificValue = process.env[envKey];
  
  if (specificValue !== undefined) {
    return specificValue === "1";
  }

  if (process.env.REI_ON_DEMAND_FILE_CONTEXT !== undefined) {
    return process.env.REI_ON_DEMAND_FILE_CONTEXT === "1";
  }

  // Valores predeterminados inteligentes:
  // - En modos de solo lectura (ask / planning): true por defecto (más rápido/ligero en local)
  // - En modo agente (agent): false por defecto (más proactivo en 1 solo turno)
  return mode === "ask" || mode === "planning";
}
