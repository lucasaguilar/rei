import "./load-env.js"; // MUST be first: loads workspace .env with override (see load-env.ts)
import { initTelemetry } from "./telemetry/init.js";
import { runCli } from "./cli/run-cli.js";

initTelemetry();

const args = process.argv.slice(2);
await runCli(args);
