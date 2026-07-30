import { parseCommandFlags } from "../parse-args.mjs";
import * as skillService from "../domain/skill-service.mjs";

export function registerSkillCommands(registry) {
  registry.register({
    name: "skill.list",
    description: "List skills library",
    handler: async ({ args }) => {
      const { flags } = parseCommandFlags(args, {
        value: ["scope", "query", "category"],
      });
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
      const { flags } = parseCommandFlags(args, { value: ["name"] });
      return { data: skillService.getSkill({ name: flags.name || args[0] }) };
    },
  });

  registry.register({
    name: "skill.unify",
    description: "Unify skill(s) to central directory",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags }) => {
      const { flags } = parseCommandFlags(args, {
        boolean: ["all", "overwrite"],
        value: ["name"],
      });
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
    description: "Install skill via shell command (use --interactive for PTY prompts)",
    mutating: true,
    dryRun: true,
    params: [
      { name: "command", required: true, type: "string" },
      { name: "name", required: false, type: "string" },
      { name: "interactive", required: false, type: "boolean", description: "Attach local PTY for prompts (web-panel parity)" },
    ],
    handler: async ({ args, flags: globalFlags }) => {
      const { flags } = parseCommandFlags(args, {
        boolean: ["interactive"],
        value: ["command", "name"],
      });
      return {
        data: await skillService.installSkill({
          command: flags.command,
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
      const { flags } = parseCommandFlags(args, {
        boolean: ["interactive"],
        value: ["id"],
      });
      return {
        data: await skillService.rerunSkillInstall({
          id: flags.id || args[0],
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