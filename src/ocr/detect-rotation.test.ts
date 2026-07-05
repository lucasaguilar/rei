import { describe, it, expect } from "vitest";
import { detectRotation } from "./detect-rotation.js";

// A valid 1x1 PNG so the real rotateDataUrl (sharp) can rotate the non-zero candidates.
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const COHERENT =
  "Los ataques cuerpo a cuerpo te permiten atacar a un objetivo que esté a tu alcance con un arma.";
const LOOP = "PÁG 18 PÁG 19 PÁG 20 PÁG 21 PÁG 22 PÁG 23 PÁG 24 PÁG 25 PÁG 26";

describe("detectRotation", () => {
  it("picks the rotation whose probe yields coherent prose (candidate order 0,90,180,270)", async () => {
    let call = 0;
    // 2nd candidate is 90° → return coherent text there, garbage elsewhere.
    const probe = async () => (++call === 2 ? COHERENT : LOOP);
    const det = await detectRotation(TINY_PNG, probe);
    expect(det.rotation).toBe(90);
    expect(det.scores[90]).toBeGreaterThan(det.scores[0]);
  });

  it("defaults to 0° when no orientation reads as prose (bad/blank scan)", async () => {
    const probe = async () => LOOP;
    const det = await detectRotation(TINY_PNG, probe);
    expect(det.rotation).toBe(0);
  });

  it("prefers 0° upright without needlessly rotating", async () => {
    const probe = async (url: string) => (url === TINY_PNG ? COHERENT : LOOP);
    // rotateDataUrl(_, 0) returns the input untouched, so only the 0° probe sees TINY_PNG.
    const det = await detectRotation(TINY_PNG, probe);
    expect(det.rotation).toBe(0);
  });

  it("survives a probe that throws (scores it 0, doesn't crash)", async () => {
    let call = 0;
    const probe = async () => {
      call += 1;
      if (call === 1) throw new Error("boom");
      return call === 2 ? COHERENT : LOOP;
    };
    const det = await detectRotation(TINY_PNG, probe);
    expect(det.rotation).toBe(90);
  });
});
