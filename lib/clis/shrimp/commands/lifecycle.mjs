import {
  parseGatewayArgs,
  runGatewayCommand,
} from "../../../cli/gateway-service.mjs";
import {
  initializeConfig,
  interactiveSetup,
} from "../../../cli/init-config.mjs";

function captureIo() {
  const lines = [];
  const errLines = [];
  return {
    lines,
    errLines,
    io: {
      log: (...args) => lines.push(args.map(String).join(" ")),
      error: (...args) => errLines.push(args.map(String).join(" ")),
    },
  };
}

async function runLifecycle(command, { args = [], context, flags }) {
  const argv = [command, ...args];
  if (flags.port) argv.push("--port", String(flags.port));
  if (flags.root || context.packageRoot) argv.push("--root", flags.root || context.packageRoot);
  if (flags.runtimeDir || context.dataDir) argv.push("--runtime-dir", flags.runtimeDir || context.dataDir);
  if (flags.force) argv.push("--force");
  if (flags.testMode) argv.push("--test");
  const options = parseGatewayArgs(argv);
  options.rootDir ||= context.packageRoot;
  options.runtimeDir ||= context.dataDir;
  const cap = captureIo();
  const result = await runGatewayCommand(options, cap.io);
  return {
    data: {
      command,
      result: result || null,
      message: cap.lines.join("\n"),
      stderr: cap.errLines.join("\n"),
    },
  };
}

export function registerLifecycleCommands(registry) {
  for (const command of ["start", "stop", "restart", "status", "logs", "stdout", "stderr", "path"]) {
    registry.register({
      name: command,
      description: `Gateway lifecycle: ${command}`,
      mutating: ["start", "stop", "restart"].includes(command),
      dryRun: false,
      handler: async ({ args, flags, context }) => runLifecycle(command, { args, flags, context }),
    });
  }

  registry.register({
    name: "init",
    description: "Create local config templates if missing",
    mutating: true,
    dryRun: true,
    handler: async ({ flags, context }) => {
      if (flags.dryRun) {
        return {
          data: {
            dry_run: true,
            data_dir: context.dataDir,
            would_create: [".env", "gateway.config.json"],
          },
        };
      }
      const result = await initializeConfig(context.packageRoot, context.dataDir);
      return { data: result };
    },
  });

  registry.register({
    name: "setup",
    description: "Interactive human setup wizard",
    mutating: true,
    dryRun: false,
    handler: async ({ context }) => {
      const result = await interactiveSetup(context.packageRoot, context.dataDir);
      return { data: result };
    },
  });
}