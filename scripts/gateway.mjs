#!/usr/bin/env node

import {
  parseGatewayArgs,
  runGatewayCommand,
} from "../lib/cli/gateway-service.mjs";

try {
  const options = parseGatewayArgs(process.argv.slice(2));
  await runGatewayCommand(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
