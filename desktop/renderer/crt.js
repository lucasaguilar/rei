/**
 * The tube. xterm.js draws the terminal into its own WebGL canvas (kept invisible, so selection and
 * focus still work on it); every frame that picture is copied into this canvas and run through two
 * passes:
 *
 *   1. phosphor — tints the picture to the phosphor's hue and lets lit cells fade instead of
 *      vanishing (persistence), like a real tube does when text scrolls or changes;
 *   2. glass    — curvature, scanlines, bloom, vignette, flicker, and the power-on/off sweep.
 *
 * Alarm red survives the tint: on an amber screen a red error that turned amber would be an error
 * nobody sees — the same rule REI's themes follow.
 */

import { knobDefaults } from "./knobs.js";

const VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const PHOSPHOR_PASS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTerm;      // what xterm.js drew this frame
uniform sampler2D uPrev;      // what this pass produced last frame
uniform vec4 uTermRect;       // where the terminal sits on the glass: x, y, w, h (0..1, y up)
uniform vec3 uScreen;         // the glass where there is no terminal (the padding)
uniform vec3 uTint;
uniform float uTintOn;
uniform float uPersistence;   // 0 = none, towards 1 = long trails

void main() {
  vec2 t = (vUv - uTermRect.xy) / uTermRect.zw;
  vec3 c = (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) ? uScreen : texture(uTerm, t).rgb;

  if (uTintOn > 0.5) {
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    vec3 mono = uTint * pow(lum, 0.85) * 1.15;
    // Keep alarms red: strongly red, weakly green and blue.
    float alarm = smoothstep(0.15, 0.35, c.r - max(c.g, c.b)) * step(0.45, c.r);
    c = mix(mono, c, alarm);
  }

  vec3 prev = texture(uPrev, vUv).rgb * uPersistence;
  outColor = vec4(max(c, prev), 1.0);
}`;

const GLASS_PASS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uImage;
uniform vec2 uRes;
uniform float uTime;
uniform float uCurvature;   // 0 = flat
uniform float uScanlines;
uniform float uBloom;
uniform float uVignette;
uniform float uFlicker;
uniform float uBrightness;
uniform float uPower;       // 0 = off, 1 = on; the sweep plays in between
uniform vec3 uGlow;         // the colour the bezel edge catches from the tube

vec2 curve(vec2 uv) {
  if (uCurvature <= 0.0) return uv;
  uv = uv * 2.0 - 1.0;
  vec2 offset = abs(uv.yx) * uCurvature;
  uv = uv + uv * offset * offset;
  return uv * 0.5 + 0.5;
}

void main() {
  vec2 uv = curve(vUv);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    // Outside the curved glass: the tube's light spilling onto the inside of the bezel.
    float d = max(max(-uv.x, uv.x - 1.0), max(-uv.y, uv.y - 1.0));
    outColor = vec4(uGlow * 0.06 * exp(-d * 40.0), 1.0);
    return;
  }

  vec3 color = texture(uImage, uv).rgb;

  // Bloom: a weighted blur over two rings. Few taps far apart draw sharp copies of the text (an
  // echo, not a glow); a dense, falling-off kernel draws a halo.
  vec3 glow = vec3(0.0);
  float total = 0.0;
  for (int ring = 1; ring <= 2; ring++) {
    float radius = float(ring) * 1.8;
    float weight = ring == 1 ? 1.0 : 0.5;
    for (int i = 0; i < 12; i++) {
      float a = float(i) * 0.5235988; // 30 degrees
      vec2 offset = vec2(cos(a), sin(a)) * radius / uRes;
      glow += texture(uImage, uv + offset).rgb * weight;
      total += weight;
    }
  }
  color += (glow / total) * uBloom;

  float scan = 0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159265 * 0.5);
  color *= 1.0 - uScanlines * scan;

  vec2 v = uv * (1.0 - uv.yx);
  color *= mix(1.0, pow(clamp(v.x * v.y * 15.0, 0.0, 1.0), 0.25), uVignette);

  color *= 1.0 - uFlicker * (0.5 + 0.5 * sin(uTime * 60.0));
  color *= uBrightness;

  // Power: the beam opens a bright horizontal line first, then the picture; it closes the same way
  // in reverse. Below 1.0 only — a running tube pays nothing for it.
  if (uPower < 1.0) {
    float wide = smoothstep(0.0, 0.3, uPower);
    float tall = smoothstep(0.25, 1.0, uPower);
    vec2 d = abs(uv - 0.5) * 2.0;
    float lit = step(d.x, max(wide, 0.003)) * step(d.y, max(tall, 0.006));
    color = (color + uGlow * (1.0 - tall) * 3.0) * lit;
  }

  outColor = vec4(color, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader failed to compile");
  }
  return shader;
}

function program(gl, fragment) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link failed");
  const uniforms = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const { name } = gl.getActiveUniform(p, i);
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { p, u: uniforms };
}

function texture(gl) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** Fixed by the tube, not offered as knobs: they read as defects when turned up. */
const TUBE = { vignette: 0.35, flicker: 0.012 };

export class Crt {
  /**
   * @param {HTMLCanvasElement} canvas  the visible glass
   * @param {() => HTMLCanvasElement | null} source  xterm's canvas (it is recreated on resize)
   * @param {() => DOMRect} termRect  where the terminal sits, in page pixels
   */
  constructor(canvas, source, termRect) {
    this.canvas = canvas;
    this.source = source;
    this.termRect = termRect;
    this.knobs = { ...TUBE, ...knobDefaults() };
    this.power = 1;
    this.tint = null;
    this.screen = [0, 0, 0];
    this.glow = [1, 0.69, 0];

    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.phosphor = program(gl, PHOSPHOR_PASS);
    this.glass = program(gl, GLASS_PASS);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.termTex = texture(gl);
    // Ping-pong pair: one holds last frame's phosphor, the other receives this frame's.
    this.persist = [texture(gl), texture(gl)];
    this.fbo = [gl.createFramebuffer(), gl.createFramebuffer()];
    this.flip = 0;
    this.size = [0, 0];
  }

  setPhosphor({ tint, screen, fg }) {
    this.tint = tint;
    this.screen = hexToRgb(screen);
    this.glow = hexToRgb(fg);
  }

  setKnobs(knobs) {
    Object.assign(this.knobs, knobs);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.size[0] && h === this.size[1]) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.size = [w, h];
    const gl = this.gl;
    for (let i = 0; i < 2; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this.persist[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.persist[i], 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  frame(time) {
    const gl = this.gl;
    this.resize();
    const [w, h] = this.size;
    const src = this.source();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.termTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (src && src.width > 0) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }

    // Terminal rectangle in glass coordinates, y flipped to GL's bottom-up.
    const glass = this.canvas.getBoundingClientRect();
    const r = this.termRect();
    const rect = [
      (r.left - glass.left) / glass.width,
      1 - (r.bottom - glass.top) / glass.height,
      r.width / glass.width,
      r.height / glass.height,
    ];

    // Pass 1: phosphor, into this frame's persistence texture.
    const read = this.flip;
    const write = 1 - this.flip;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[write]);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.phosphor.p);
    let u = this.phosphor.u;
    gl.uniform1i(u.uTerm, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.persist[read]);
    gl.uniform1i(u.uPrev, 1);
    gl.uniform4f(u.uTermRect, ...rect);
    gl.uniform3f(u.uScreen, ...this.screen);
    gl.uniform3f(u.uTint, ...(this.tint ?? [1, 1, 1]));
    gl.uniform1f(u.uTintOn, this.tint ? 1 : 0);
    gl.uniform1f(u.uPersistence, this.knobs.persistence);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 2: glass, to the screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.glass.p);
    u = this.glass.u;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.persist[write]);
    gl.uniform1i(u.uImage, 0);
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uTime, time / 1000);
    gl.uniform1f(u.uCurvature, this.knobs.curvature);
    gl.uniform1f(u.uScanlines, this.knobs.scanlines);
    gl.uniform1f(u.uBloom, this.knobs.bloom);
    gl.uniform1f(u.uVignette, this.knobs.vignette);
    gl.uniform1f(u.uFlicker, this.knobs.flicker);
    gl.uniform1f(u.uBrightness, this.knobs.brightness);
    gl.uniform1f(u.uPower, this.power);
    gl.uniform3f(u.uGlow, ...this.glow);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.flip = write;
  }

  /** Animates the beam to `target` (1 = on, 0 = off). Resolves when the sweep is done. */
  sweep(target, ms) {
    const from = this.power;
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = (now) => {
        const k = Math.min(1, (now - t0) / ms);
        this.power = from + (target - from) * k;
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  start() {
    const loop = (t) => {
      this.frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
}
