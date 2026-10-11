/**
 * The monitor's knobs: what the user may turn, how far, and where each one sits from the factory.
 * One list, read by the bezel (to draw them), the tube (for defaults) and the settings (to clamp).
 */
export const KNOBS = [
  { key: "brightness", label: "BRIGHT", min: 0.6, max: 1.6, default: 1.0, step: 0.02 },
  { key: "curvature", label: "CURVE", min: 0, max: 0.4, default: 0.18, step: 0.01 },
  { key: "scanlines", label: "SCAN", min: 0, max: 0.6, default: 0.28, step: 0.01 },
  { key: "bloom", label: "GLOW", min: 0, max: 1.2, default: 0.45, step: 0.02 },
  { key: "persistence", label: "TRAIL", min: 0, max: 0.95, default: 0.82, step: 0.01 },
];

export const knobDefaults = () => Object.fromEntries(KNOBS.map((k) => [k.key, k.default]));

/** Every knob present, numeric and in range; anything else falls back to the factory position. */
export function clampKnobs(raw = {}) {
  const out = {};
  for (const k of KNOBS) {
    const v = raw[k.key];
    out[k.key] = typeof v === "number" && Number.isFinite(v) ? Math.min(k.max, Math.max(k.min, v)) : k.default;
  }
  return out;
}
