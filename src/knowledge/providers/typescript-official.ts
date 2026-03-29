import { BaseOfficialProvider } from "./base-official-provider.js";

export class TypeScriptOfficialProvider extends BaseOfficialProvider {
  name = "TypeScript Official";

  protected triggerKeywords = [
    "typescript",
    "tsconfig",
    "mapped types",
    "infer",
    "conditional types",
    "utility types",
    "type guards",
    "interface vs type"
  ];

  protected allowedDomains = ["typescriptlang.org"];
}
