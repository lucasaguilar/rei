export const ANALYSIS_PATTERN =
  /\b(analy[sz]e|analysis|review|inspect|explain|understand|diagnos(?:e|is)|analizy|revis[ae]|revisar|verific[ae]|verificar|mostr[ae]|mostrar|pass?arme|dame|dime|decime|tell me|show me|find|busca[r]?|encontr[ae]|listar?|explicame|expl[ií]came|mostrarme|pasame|ver)\b/;

export const MUTATION_PATTERN =
  /\b(add|change|modify|update|fix|implement|create|remove|delete|refactor|write|insert|patch|agrega[r]?|cambia[r]?|modifica[r]?|actualiza[r]?|arregla[r]?|implementa[r]?|crea[r]?|elimina[r]?|borra[r]?|reescrib[ei]r?)\b/;

export const READ_ONLY_INSPECTION_PATTERN =
  /\b(show me|tell me|inspect|review|explain|understand|mostr[ae]|mostrar|mostrarme|pasame|dame|dime|decime|c[oó]digo exacto|exact code|full code|contenido completo|completo|expl[ií]came|ver|see|list|listar)\b/;

export const COMPLETED_RESPONSE_PATTERN =
  /\b(provided|showed|shown|reviewed|inspected|explained|listed|shared|displayed|returned|delivered)\b/i;

export const APPLIED_CHANGE_PATTERN =
  /\b(added|updated|modified|changed|implemented|fixed|removed|created|wrote|inserted|applied|patched|refactored)\b/i;
