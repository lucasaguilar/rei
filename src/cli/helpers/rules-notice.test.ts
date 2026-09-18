import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rulesMigrationNotice } from "./rules-notice.helper.js";
import { RULES_TEMPLATES_ROOT } from "../../chat/commands/rules-commands.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-rules-notice-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const angularProject = () => {
  writeFileSync(join(ws, "angular.json"), "{}");
  writeFileSync(join(ws, "package.json"), JSON.stringify({ dependencies: { "@angular/core": "21" } }));
};

/**
 * Removing REI's built-in Angular rules is silent for a project that was relying on them: nothing
 * breaks, the model just starts writing `*ngIf` again and you find out in review. So it is said
 * once, at startup, where it can still be acted on.
 */
describe("the rules migration notice", () => {
  it("tells an Angular project with no rules file that REI no longer supplies them", () => {
    angularProject();
    const notice = rulesMigrationNotice(ws, RULES_TEMPLATES_ROOT);
    expect(notice).toContain("angular");
    expect(notice).toContain("/rules install angular");
  });

  it("stays quiet when the project already wrote its own rules", () => {
    angularProject();
    mkdirSync(join(ws, ".rei"), { recursive: true });
    writeFileSync(join(ws, ".rei", "rules.md"), "# las nuestras\n");
    // That project answered the question already, and REI does not get to grade the answer.
    expect(rulesMigrationNotice(ws, RULES_TEMPLATES_ROOT)).toBeNull();
  });

  it("stays quiet for a stack REI has no template for", () => {
    writeFileSync(join(ws, "main.py"), "print('hola')\n");
    expect(rulesMigrationNotice(ws, RULES_TEMPLATES_ROOT)).toBeNull();
  });
});
