import { BaseOfficialProvider } from "./base-official-provider.js";

export class NodeOfficialProvider extends BaseOfficialProvider {
  name = "Node.js Official";

  protected triggerKeywords = [
    "node.js",
    "nodejs",
    "node streams",
    "buffer",
    "process.env",
    "eventemitter",
    "worker threads",
    "child_process"
  ];

  protected allowedDomains = ["nodejs.org"];
}
