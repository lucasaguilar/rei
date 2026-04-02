import { runCli } from "./cli/run-cli.js";

const args = process.argv.slice(2);
await runCli(args);
