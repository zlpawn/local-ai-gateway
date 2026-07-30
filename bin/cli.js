#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runShrimpCli } from "../lib/clis/shrimp/index.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await runShrimpCli(process.argv.slice(2), { packageRoot });
process.exitCode = result.exitCode;
