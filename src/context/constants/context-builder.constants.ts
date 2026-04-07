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
export const MAX_CALLER_CONTEXT_FILES = 5;
export const MAX_RAG_NODE_SNIPPET_CHARS = 3000;
export const ENABLE_SEMANTIC_RAG_SEARCH = false;
