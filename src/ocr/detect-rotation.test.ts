import { describe, it, expect } from "vitest";
import { detectRotation, type Rotation } from "./detect-rotation.js";
import type { TextAxis } from "./text-axis.js";

// A valid 4x4 PNG so the real rotateDataUrl (sharp) can rotate the non-zero candidates.
// (The old 1x1 fixture decoded fine on libpng < 1.6.40 but libvips 8.18+ / sharp 0.35 rejects
// it with "libpng read error" — real rendered pages are never 1x1, so this is fixture-only.)
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWOoQAIMxHEASVIWgSs3xboAAAAASUVORK5CYII=";

const COHERENT =
  "Los ataques cuerpo a cuerpo te permiten atacar a un objetivo que esté a tu alcance con un arma.";
const LOOP = "PÁG 18 PÁG 19 PÁG 20 PÁG 21 PÁG 22 PÁG 23 PÁG 24 PÁG 25 PÁG 26";

const axis = (a: TextAxis) => async () => a;

describe("detectRotation", () => {
  it("vertical axis → probes 90/270 and picks the coherent 90 (candidate order 90,270)", async () => {
    let call = 0;
    const probe = async () => (++call === 1 ? COHERENT : LOOP);
    const det = await detectRotation(TINY_PNG, probe, undefined, axis("vertical"));
    expect(det.rotation).toBe(90);
    expect(det.axis).toBe("vertical");
    expect(det.scores[180]).toBeUndefined(); // wrong-axis orientation never probed
  });

  it("horizontal axis → probes 0/180 and picks the coherent 0", async () => {
    let call = 0;
    const probe = async () => (++call === 1 ? COHERENT : LOOP);
    const det = await detectRotation(TINY_PNG, probe, undefined, axis("horizontal"));
    expect(det.rotation).toBe(0);
  });

  it("falls back to the other axis when the primary one reads as garbage", async () => {
    // Axis guesses horizontal [0,180] (both garbage) → should then probe vertical [90,270] and find 90.
    let call = 0;
    const probe = async () => (++call === 3 ? COHERENT : LOOP);
    const det = await detectRotation(TINY_PNG, probe, undefined, axis("horizontal"));
    expect(det.rotation).toBe(90);
  });

  it("defaults to 0° when nothing on either axis reads as prose", async () => {
    const det = await detectRotation(TINY_PNG, async () => LOOP, undefined, axis("vertical"));
    expect(det.rotation).toBe(0);
  });

  it("survives a probe that throws (scores it 0, keeps going)", async () => {
    let call = 0;
    const probe = async () => {
      if (++call === 1) throw new Error("boom"); // 90° probe fails
      return COHERENT; // 270° reads fine
    };
    const det = await detectRotation(TINY_PNG, probe, undefined, axis("vertical"));
    expect(det.rotation).toBe(270 as Rotation);
  });
});
