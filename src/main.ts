import "dotenv/config";
import { initTelemetry } from "./telemetry/init.js";
import { runCli } from "./cli/run-cli.js";

initTelemetry();

const args = process.argv.slice(2);
await runCli(args);
