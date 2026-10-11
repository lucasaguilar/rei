/**
 * What the monitor prints between the power-on sweep and REI's first line: the POST screen of an
 * 80s machine with a Hercules card. Flavour, but honest flavour — the workspace and the phosphor
 * are real, and nothing claims a check that did not happen.
 */
const PHOSPHOR_TYPE = { amber: "P3 amber", green: "P1 green", violet: "colour" };

export function bootLines({ workspace, phosphor, version }) {
  return [
    `REI BIOS ${version}  (C) 2026 Lucas Aguilar`,
    `Hercules-compatible display · 720x348 · phosphor ${PHOSPHOR_TYPE[phosphor] ?? phosphor}`,
    "",
    "Memory test: {memory}",
    "",
    `Workspace: ${workspace}`,
    "Starting REI...",
    "",
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Types the boot screen into the terminal. Any key skips it: the nostalgia is for the first look,
 * not for every launch someone is in a hurry.
 */
export async function playBoot(term, info) {
  let skipped = false;
  const skip = term.onKey(() => (skipped = true));
  const wait = (ms) => (skipped ? Promise.resolve() : sleep(ms));

  for (const line of bootLines(info)) {
    if (line.includes("{memory}")) {
      const [before] = line.split("{memory}");
      for (let kb = 0; kb <= 640 && !skipped; kb += 32) {
        term.write(`\r${before}${String(kb).padStart(3)}K`);
        await wait(28);
      }
      term.write(`\r${before}640K OK\r\n`);
      continue;
    }
    term.write(line + "\r\n");
    await wait(line ? 140 : 60);
  }
  await wait(350);
  skip.dispose();
  term.write("\x1b[2J\x1b[H"); // REI starts on a clean screen, as a program would after POST
}
