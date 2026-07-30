import { resolveInstallInvocation } from "../parse-args.mjs";
import * as skillService from "../domain/skill-service.mjs";

export function registerSkillCommands(registry) {
  registry.register({
    name: "skill.list",
    description: "List skills library",
    handler: async ({ args }) => {
      const { flags } = resolveListish(args, ["scope", "query", "category"]);
      return {
        data: skillService.listSkills({
          scope: flags.scope || "all",
          query: flags.query || "",
          category: flags.category || "all",
        }),
      };
    },
  });

  registry.register({
    name: "skill.get",
    description: "Get one skill",
    handler: async ({ args }) => {
      const { flags, positionals } = resolveListish(args, ["name"]);
      return { data: skillService.getSkill({ name: flags.name || positionals[0] }) };
    },
  });

  registry.register({
    name: "skill.unify",
    description: "Unify skill(s) to central directory",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags }) => {
      const { flags } = resolveListish(args, ["name"], ["all", "overwrite"]);
      if (globalFlags.dryRun) {
        return { data: { dry_run: true, name: flags.name || null, all: Boolean(flags.all) } };
      }
      return {
        data: skillService.unifySkills({
          name: flags.name,
          all: Boolean(flags.all),
          overwrite: Boolean(flags.overwrite),
        }),
      };
    },
  });

  registry.register({
    name: "skill.install",
    description: "Install skill via shell command. --command optional; trailing args become the command.",
    mutating: true,
    dryRun: true,
    params: [
      { name: "command", required: false, type: "string", description: "Optional; if omitted, trailing args form the command" },
      { name: "name", required: false, type: "string" },
      { name: "interactive", required: false, type: "boolean", description: "Attach local PTY for prompts (web-panel parity)" },
    ],
    handler: async ({ args, flags: globalFlags }) => {
      const { flags, command } = resolveInstallInvocation(args, {
        boolean: ["interactive"],
        value: ["command", "name"],
      });
      return {
        data: await skillService.installSkill({
          command,
          name: flags.name,
          dryRun: globalFlags.dryRun,
          interactive: Boolean(flags.interactive),
        }),
      };
    },
  });

  registry.register({
    name: "skill.history.list",
    description: "List skill install history",
    handler: async () => ({ data: skillService.listSkillHistory() }),
  });

  registry.register({
    name: "skill.history.rerun",
    description: "Re-run a skill install history record",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags }) => {
      const { flags, positionals } = resolveListish(args, ["id"], ["interactive"]);
      return {
        data: await skillService.rerunSkillInstall({
          id: flags.id || positionals[0],
          interactive: Boolean(flags.interactive),
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });

  registry.register({
    name: "skill.refresh",
    description: "Refresh skills library snapshot",
    handler: async () => ({ data: skillService.listSkills({}) }),
  });
}

function resolveListish(argv = [], value = [], boolean = []) {
  const boolSet = new Set(boolean);
  const valueSet = new Set(value);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]);
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) {
      const eq = token.indexOf("=");
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const name = token.replace(/^--?/, "");
    if (boolSet.has(name)) {
      flags[name] = true;
      continue;
    }
    if (valueSet.has(name)) {
      flags[name] = argv[++i];
      continue;
    }
    flags[name] = true;
  }
  return { flags, positionals };
}