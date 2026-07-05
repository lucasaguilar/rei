import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkpointPath,
  readCheckpoint,
  appendCheckpointPage,
} from "./ocr-checkpoint.js";

describe("ocr-checkpoint", () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-ocr-cp-"));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("checkpointPath lands hidden under .rei/ocr with a .pages.md name", () => {
    const p = checkpointPath("/somewhere/Downloads/guia escaneada.pdf", ws);
    expect(p).toBe(path.join(ws, ".rei", "ocr", "guia escaneada.pages.md"));
  });

  it("readCheckpoint returns an empty map when the file does not exist", async () => {
    const done = await readCheckpoint(checkpointPath("x.pdf", ws));
    expect(done.size).toBe(0);
  });

  it("appends pages and reads them back as a page→text map (round-trip)", async () => {
    const file = checkpointPath("doc.pdf", ws);
    await appendCheckpointPage(file, 1, "primera página");
    await appendCheckpointPage(file, 2, "segunda página");

    const done = await readCheckpoint(file);
    expect(done.size).toBe(2);
    expect(done.get(1)).toBe("primera página");
    expect(done.get(2)).toBe("segunda página");
  });

  it("reads pages regardless of append (completion) order", async () => {
    const file = checkpointPath("doc.pdf", ws);
    // Simulate a resume: page 5 done first run, then 3 and 4 on a retry.
    await appendCheckpointPage(file, 5, "cinco");
    await appendCheckpointPage(file, 3, "tres");
    await appendCheckpointPage(file, 4, "cuatro");

    const done = await readCheckpoint(file);
    expect([...done.keys()].sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(done.get(3)).toBe("tres");
  });

  it("treats a marker with no text below it as NOT done (so it gets retried)", async () => {
    const file = checkpointPath("doc.pdf", ws);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    // A page marker with an empty body must not count as a completed page.
    await fs.promises.writeFile(
      file,
      "--- Page 1 ---\nreal text\n\n--- Page 2 ---\n\n",
      "utf-8",
    );
    const done = await readCheckpoint(file);
    expect(done.has(1)).toBe(true);
    expect(done.has(2)).toBe(false);
  });
});
