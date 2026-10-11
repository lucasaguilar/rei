import * as nodeFs from "node:fs";
import { DEFAULT_PHOSPHOR, isPhosphor } from "../renderer/phosphors.js";
import { clampKnobs } from "../renderer/knobs.js";

const realFs = {
  readFile: (p) => nodeFs.readFileSync(p, "utf8"),
  writeFile: (p, data) => nodeFs.writeFileSync(p, data),
};

/**
 * The monitor's state between launches: its phosphor and its knobs. A missing or corrupt file is a
 * monitor fresh from the factory, never a window that refuses to open.
 */
export function loadSettings(file, fs = realFs) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFile(file)) ?? {};
  } catch {
    // ENOENT on first launch, or a hand-edit gone wrong: start from the defaults.
  }
  return {
    phosphor: isPhosphor(raw.phosphor) ? raw.phosphor : DEFAULT_PHOSPHOR,
    knobs: clampKnobs(raw.knobs),
  };
}

export function saveSettings(file, settings, fs = realFs) {
  const clean = {
    phosphor: isPhosphor(settings.phosphor) ? settings.phosphor : DEFAULT_PHOSPHOR,
    knobs: clampKnobs(settings.knobs),
  };
  fs.writeFile(file, JSON.stringify(clean, null, 2) + "\n");
  return clean;
}
