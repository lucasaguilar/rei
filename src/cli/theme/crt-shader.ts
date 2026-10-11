/**
 * REI's CRT for Ghostty's `custom-shader` (Shadertoy conventions: iChannel0 is the terminal,
 * iResolution its size in pixels, iTime the clock). Tuned for the phosphor themes, harmless on any.
 *
 * Kept as a string, not a file next to the build: an installed REI has no reliable path back to
 * repo assets, and a shader that cannot be found is a /theme crt that silently does nothing.
 */
export const CRT_SHADER = `// REI — CRT phosphor for Ghostty. https://github.com/lucasaguilar/rei
// Scanlines, phosphor bloom, curved glass, vignette and a slow flicker.
// Tune the constants; set one to 0.0 to turn that effect off.

const float CURVATURE = 5.0;   // higher = flatter glass; 0.0 disables the curve
const float SCANLINES = 0.25;  // darkness of the gaps between scanlines
const float BLOOM     = 0.30;  // phosphor glow around lit text
const float VIGNETTE  = 0.35;  // darkening towards the edges of the tube
const float FLICKER   = 0.012; // brightness wobble

vec2 curve(vec2 uv) {
  if (CURVATURE <= 0.0) return uv;
  uv = uv * 2.0 - 1.0;
  vec2 offset = abs(uv.yx) / CURVATURE;
  uv = uv + uv * offset * offset;
  return uv * 0.5 + 0.5;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = curve(fragCoord / iResolution.xy);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 color = texture(iChannel0, uv).rgb;

  // Bloom: a cheap ring of taps, so bright glyphs bleed into the glass around them.
  vec2 px = 1.5 / iResolution.xy;
  vec3 glow = vec3(0.0);
  glow += texture(iChannel0, uv + vec2( px.x,  0.0)).rgb;
  glow += texture(iChannel0, uv + vec2(-px.x,  0.0)).rgb;
  glow += texture(iChannel0, uv + vec2( 0.0,  px.y)).rgb;
  glow += texture(iChannel0, uv + vec2( 0.0, -px.y)).rgb;
  glow += texture(iChannel0, uv + vec2( px.x,  px.y) * 2.0).rgb;
  glow += texture(iChannel0, uv + vec2(-px.x,  px.y) * 2.0).rgb;
  glow += texture(iChannel0, uv + vec2( px.x, -px.y) * 2.0).rgb;
  glow += texture(iChannel0, uv + vec2(-px.x, -px.y) * 2.0).rgb;
  color += (glow / 8.0) * BLOOM;

  // Scanlines: one dark gap every other pixel row.
  float scan = 0.5 + 0.5 * sin(fragCoord.y * 3.14159265);
  color *= 1.0 - SCANLINES * scan;

  // Vignette.
  vec2 v = uv * (1.0 - uv.yx);
  color *= mix(1.0, pow(clamp(v.x * v.y * 15.0, 0.0, 1.0), 0.25), VIGNETTE);

  // Flicker.
  color *= 1.0 - FLICKER * (0.5 + 0.5 * sin(iTime * 60.0));

  fragColor = vec4(color, 1.0);
}
`;
