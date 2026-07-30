import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeConfig,
  loadEnvironmentFile,
} from "../../cli/init-config.mjs";
import { CLI_NAME } from "./constants.mjs";
import { createRegistry } from "./registry.mjs";
import { printError, printSuccess } from "./protocol.mjs";
import { detectDataDir, resolveConfigPaths } from "./domain/paths.mjs";
import { registerSchemaCommands } from "./commands/schema.mjs";
import { registerLifecycleCommands } from "./commands/lifecycle.mjs";
import { registerConfigCommands } from "./commands/config.mjs";
import { registerEndpointCommands } from "./commands/endpoint.mjs";
import { registerSecretCommands } from "./commands/secret.mjs";
import { registerClientCommands } from "./commands/client.mjs";
import { registerDoctorCommands } from "./commands/doctor.mjs";
import { registerUpstreamCommands } from "./commands/upstream.mjs";
import { registerSyncCommands } from "./commands/sync.mjs";
import { registerApplyCommands } from "./commands/apply.mjs";
import { registerSkillCommands } from "./commands/skill.mjs";
import { registerCliToolCommands } from "./commands/cli-tool.mjs";
import { registerToolCommands } from "./commands/tool.mjs";

export function buildRegistry() {
  const registry = createRegistry();
  registerSchemaCommands(registry);
  registerLifecycleCommands(registry);
  registerConfigCommands(registry);
  registerEndpointCommands(registry);
  registerSecretCommands(registry);
  registerClientCommands(registry);
  registerApplyCommands(registry);
  registerDoctorCommands(registry);
  registerUpstreamCommands(registry);
  registerSyncCommands(registry);
  registerSkillCommands(registry);
  registerCliToolCommands(registry);
  registerToolCommands(registry);
  return registry;
}

export async function runShrimpCli(argv = process.argv.slice(2), options = {}) {
  const packageRoot = options.packageRoot
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const io = options.io || console;

  const dataDirFlagIndex = argv.findIndex((x) => x === "--data-dir");
  if (dataDirFlagIndex >= 0 && argv[dataDirFlagIndex + 1]) {
    env.GATEWAY_DATA_DIR = argv[dataDirFlagIndex + 1];
  }

  const dataDir = options.dataDir || detectDataDir(packageRoot, { cwd, env });
  await initializeConfig(packageRoot, dataDir);
  await loadEnvironmentFile(path.join(dataDir, ".env"), env);

  const configFile = (() => {
    const idx = argv.findIndex((x) => x === "--config-file");
    return idx >= 0 ? argv[idx + 1] : env.GATEWAY_CONFIG_FILE;
  })();
  const secretsFile = (() => {
    const idx = argv.findIndex((x) => x === "--secrets-file");
    return idx >= 0 ? argv[idx + 1] : env.GATEWAY_SECRETS_FILE;
  })();

  const paths = resolveConfigPaths(dataDir, {
    configFile,
    secretsFile,
  }, env);
  env.GATEWAY_CONFIG_FILE = paths.configPath;
  env.GATEWAY_SECRETS_FILE = paths.secretsPath;

  const registry = options.registry || buildRegistry();
  const effectiveArgv = argv.length ? argv : ["start"];
  const dispatched = await registry.dispatch(effectiveArgv, {
    packageRoot,
    dataDir,
    paths,
    cwd,
    env,
    cliName: CLI_NAME,
  });

  if (dispatched.ok) printSuccess(io, dispatched.envelope, dispatched.format);
  else printError(io, dispatched.envelope, dispatched.format);

  return {
    exitCode: dispatched.exitCode,
    envelope: dispatched.envelope,
  };
}

export default runShrimpCli;