import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * REI's user-facing output is English. Its author writes Spanish, so it drifts back.
 *
 * This is not style policing. Before launch the agent printed `Archivo:` above every diff, `[REI]
 * No hay documento activo` from six commands, and a Git summary whose header was English and whose
 * body was Spanish — the first thing a new user would see, in a language the README never uses.
 *
 * Spanish that handles INPUT is a different thing and stays: stopword lists, ordinal parsing, and
 * the narrate-don't-act patterns exist so REI works for someone typing Spanish. They are exempted
 * by file, with the reason written down. Test fixtures are exempt for the same reason — Spanish
 * fixtures are the coverage proving that input works.
 */

const SRC = path.resolve(__dirname, "..");

/** Files whose Spanish is input handling, not output. */
const BILINGUAL_INPUT: Record<string, string> = {
  "context/caller-graph.ts": "Spanish stopwords for query→file matching",
  "workspace/file-selector.ts": "Spanish stopwords for query→file matching",
  "ocr/rotation-score.ts": "Spanish word list scoring OCR orientation",
  "skills/ask-document/slice.ts": "Spanish ordinals (primera, séptima…) for page references",
  "agent-mode/native-tools-directive.ts": "narrate-don't-act detection patterns",
};

const ACCENT = /[ñÑ¿¡áéíóúÁÉÍÓÚ]/;
const SPANISH_WORDS =
  /\b(que|para|con|del|los|las|una|por|como|donde|cuando|hasta|este|esta|todo|sobre|sin|hay|son|fue|ser|tiene|puede|archivo|archivos|cambios|documento|busqueda|respuesta|pregunta|activa|indica|arrastra|usa|probando|lineas)\b/gi;
/**
 * Spanish morphology: past participles, gerunds and -ción nouns. Function words alone were not
 * enough — "Comando repetido bloqueado" shipped past this test with no accent and no article in
 * it, and it is exactly the shape a status line takes.
 */
const SPANISH_SHAPE = /\b\w{4,}(?:ado|ada|ido|ida|ando|iendo|cion|ciones|mente)\b/gi;
/** English words that happen to end like Spanish ones. */
const FALSE_FRIENDS = new Set([
  "tornado", "avocado", "bravado", "desperado", "armada", "florida", "valid", "solid",
  "comment", "commented", "documented", "implemented",
]);
const STRING_LITERAL = /"([^"\n]{4,})"|'([^'\n]{4,})'|`([^`\n]{4,})`/g;
const deaccent = (s: string) =>
  s.replace(/[áéíóú]/g, (c) => "aeiou"["áéíóú".indexOf(c)]).replace(/[ÁÉÍÓÚ]/g, (c) => "AEIOU"["ÁÉÍÓÚ".indexOf(c)]);

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });

/** A string is flagged on an accent, or on two DISTINCT Spanish function words — one is a coincidence. */
function spanishStringsIn(body: string): string[] {
  const found: string[] = [];
  for (const [i, line] of body.split("\n").entries()) {
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue; // comments are a separate cleanup
    for (const m of line.matchAll(STRING_LITERAL)) {
      const s = m[1] ?? m[2] ?? m[3] ?? "";
      const plain = deaccent(s);
      const words = new Set((plain.match(SPANISH_WORDS) ?? []).map((w) => w.toLowerCase()));
      const shaped = new Set(
        (plain.match(SPANISH_SHAPE) ?? [])
          .map((w) => w.toLowerCase())
          .filter((w) => !FALSE_FRIENDS.has(w)),
      );
      if (ACCENT.test(s) || words.size >= 2 || shaped.size >= 2) {
        found.push(`line ${i + 1}: ${s.slice(0, 70)}`);
        break;
      }
    }
  }
  return found;
}

describe("user-facing output is in English", () => {
  it("has no Spanish string literals in production code", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (rel in BILINGUAL_INPUT) continue;
      for (const hit of spanishStringsIn(fs.readFileSync(file, "utf-8"))) {
        offenders.push(`${rel} ${hit}`);
      }
    }
    expect(
      offenders,
      "Spanish string literals in production code. Translate them, or — if the Spanish is there " +
        "to handle Spanish INPUT — add the file to BILINGUAL_INPUT with the reason.",
    ).toEqual([]);
  });

  it("keeps the exemption list honest — every exempted file still exists", () => {
    for (const f of Object.keys(BILINGUAL_INPUT)) {
      expect(fs.existsSync(path.join(SRC, f)), `${f} is exempted but does not exist`).toBe(true);
    }
  });

  it("detects the strings that actually shipped, so the net is not decorative", () => {
    // The three shapes this missed across two earlier sweeps: a bare label, an accent-free
    // sentence, and a template literal.
    expect(spanishStringsIn('const a = "No hay documento activo, usá /doc";')).toHaveLength(1);
    expect(spanishStringsIn("const b = `pág. ${n}`;")).toHaveLength(1);
    expect(spanishStringsIn('const c = "No changes detected in the repository.";')).toHaveLength(0);
    // The one that got through: no accent, no article — just Spanish morphology.
    expect(spanishStringsIn('emitStatus(`Comando repetido bloqueado: ${c}`);')).toHaveLength(1);
    // …and English that merely ends the same way must not trip it.
    expect(spanishStringsIn('const d = "Documented and implemented the command";')).toHaveLength(0);
  });
});
