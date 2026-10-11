import { KNOBS } from "./knobs.js";
import { PHOSPHORS } from "./phosphors.js";

const SWEEP = 270; // degrees a knob turns from min to max, like a real potentiometer

/**
 * A rotary knob: drag up/down or scroll to turn, double-click for the factory position, arrow keys
 * when focused. Exposed as an ARIA slider, because that is what it is.
 */
function mountKnob(spec, value, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "knob";
  wrap.innerHTML = `<div class="knob-dial" role="slider" tabindex="0"><span class="knob-mark"></span></div><label>${spec.label}</label>`;
  const dial = wrap.querySelector(".knob-dial");
  dial.setAttribute("aria-label", spec.label);
  dial.setAttribute("aria-valuemin", spec.min);
  dial.setAttribute("aria-valuemax", spec.max);

  let current = value;
  const set = (v, emit = true) => {
    current = Math.min(spec.max, Math.max(spec.min, Math.round(v / spec.step) * spec.step));
    const t = (current - spec.min) / (spec.max - spec.min);
    dial.style.setProperty("--turn", `${-SWEEP / 2 + t * SWEEP}deg`);
    dial.setAttribute("aria-valuenow", current.toFixed(2));
    if (emit) onChange(spec.key, current);
  };
  set(value, false);

  const perPixel = (spec.max - spec.min) / 160;
  dial.addEventListener("pointerdown", (e) => {
    dial.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const start = current;
    const move = (ev) => set(start + (startY - ev.clientY) * perPixel);
    const up = () => {
      dial.removeEventListener("pointermove", move);
      dial.removeEventListener("pointerup", up);
    };
    dial.addEventListener("pointermove", move);
    dial.addEventListener("pointerup", up);
  });
  dial.addEventListener("wheel", (e) => {
    e.preventDefault();
    set(current - Math.sign(e.deltaY) * spec.step * 2);
  }, { passive: false });
  dial.addEventListener("dblclick", () => set(spec.default));
  dial.addEventListener("keydown", (e) => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (d) {
      e.preventDefault();
      set(current + d * spec.step);
    }
  });
  return wrap;
}

/**
 * The panel under the glass. Everything it changes is reported through `on`; it owns no state
 * beyond what it draws.
 */
export function mountBezel(panel, { phosphor, knobs }, on) {
  const knobRow = panel.querySelector(".knobs");
  for (const spec of KNOBS) knobRow.append(mountKnob(spec, knobs[spec.key], on.knob));

  const sw = panel.querySelector(".phosphor-switch");
  for (const [name, p] of Object.entries(PHOSPHORS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.phosphor = name;
    b.title = p.name;
    b.innerHTML = `<i style="--dot:${p.fg}"></i>${p.label}`;
    b.setAttribute("aria-pressed", String(name === phosphor));
    b.addEventListener("click", () => {
      sw.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      on.phosphor(name);
    });
    sw.append(b);
  }
}

/** A line of text on the bezel that fades — for the one thing worth saying out loud. */
export function toast(el, text) {
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 4200);
}
