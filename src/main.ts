import { runCli } from "./cli/run-cli.js";

const args = process.argv.slice(2);
console.log('Starting REI...');
await runCli(args);
