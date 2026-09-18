import { describe, it, expect, afterEach } from "vitest";
import { themeCommands } from "./theme-commands.js";
import { activeThemeName, setTheme } from "../../cli/theme/palette.js";
import type { CommandContext, CommandResult } from "./command-handler.js";

afterEach(() => setTheme(undefined));

const run = async (command: string): Promise<CommandResult> =>
  (await themeCommands.run({ command } as CommandContext)) as CommandResult;

describe("/theme", () => {
  it("claims its own command and nothing else", () => {
    expect(themeCommands.match("/theme")).toBe(true);
    expect(themeCommands.match("/theme matrix")).toBe(true);
    expect(themeCommands.match("/themes")).toBe(false);
    expect(themeCommands.match("/think")).toBe(false);
  });

  it("lists what there is and marks the active one", async () => {
    const { response } = await run("/theme");
    expect(response).toContain("default (active)");
    expect(response).toContain("matrix");
  });

  it("switches, and the switch is what the rest of the UI reads", async () => {
    await run("/theme matrix");
    expect(activeThemeName()).toBe("matrix");
  });

  it("says a dark theme is a dark theme instead of letting it read as a bug", async () => {
    const { response } = await run("/theme matrix");
    expect(response).toContain("dark terminal");
  });

  it("refuses a theme that does not exist, and says what does", async () => {
    const result = await run("/theme dracula");
    expect(result.success).toBe(false);
    expect(result.response).toContain("default, matrix");
    expect(activeThemeName()).toBe("default");
  });
});
