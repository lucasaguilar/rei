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

export const EXPLICIT_CONTENT_REQUEST_PATTERN =
  /c[oó]digo exacto|exact code|full code|complete code|contenido completo|c[oó]digo completo|full content|complete file|todas las funciones|all functions|show.{0,15}code|mostrame.{0,25}c[oó]digo|dame.{0,25}c[oó]digo/;

export const CHANGE_INTENT_PATTERN =
  /\b(add|change|modify|update|fix|implement|create|remove|delete|refactor|agreg|cambi|modific|actualiz|arregl|implement|cre[ar]|elimin|borr)\w*/i;

export const MAX_CALLER_SEARCH_RESULTS = 15;
export const MAX_CALLER_CONTEXT_FILES = 3;
export const MAX_RAG_NODE_SNIPPET_CHARS = 2000;
export const ENABLE_SEMANTIC_RAG_SEARCH = true;
export const MAX_RELEVANT_FILES_AGENT = 5;
export const MAX_RELEVANT_FILES_NON_AGENT = 3;
export const MIN_RAG_SCORE_FOR_FILE_PREVIEW = 0.4;
export const ON_DEMAND_FILE_CONTEXT =
  process.env.REI_ON_DEMAND_FILE_CONTEXT === "1";
