import { SkillInstaller } from "../../../session-sync/skill-installer.mjs";
import { SessionWatcherDaemon } from "../../../session-sync/watcher-daemon.mjs";
import { parseCommandFlags } from "../parse-args.mjs";
import { loadStateOrThrow, saveState } from "../domain/config-service.mjs";

export function registerSyncCommands(registry) {
  registry.register({
    name: "sync.status",
    description: "Session sync status",
    handler: async () => {
      const daemon = new SessionWatcherDaemon();
      return { data: daemon.status() };
    },
  });

  registry.register({
    name: "sync.install-skill",
    description: "Install session-sync skill",
    mutating: true,
    dryRun: false,
    handler: async () => {
      const installedPath = SkillInstaller.install();
      return { data: { installedPath } };
    },
  });

  registry.register({
    name: "sync.enable",
    description: "Enable session sync in config",
    mutating: true,
    dryRun: true,
    handler: async ({ flags, context }) => setSyncEnabled(context, true, flags.dryRun),
  });

  registry.register({
    name: "sync.disable",
    description: "Disable session sync in config",
    mutating: true,
    dryRun: true,
    handler: async ({ flags, context }) => setSyncEnabled(context, false, flags.dryRun),
  });

  registry.register({
    name: "sync.set",
    description: "Update session sync settings",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, {
        value: ["start-date", "end-date", "summary-mode", "summary-model"],
      });
      const state = loadStateOrThrow(context.paths);
      state.config.sessionSync = {
        ...(state.config.sessionSync || {}),
        ...(flags["start-date"] ? { startDate: flags["start-date"] } : {}),
        ...(flags["end-date"] ? { endDate: flags["end-date"] } : {}),
        ...(flags["summary-mode"] ? { summaryMode: flags["summary-mode"] } : {}),
        ...(flags["summary-model"] ? { summaryModel: flags["summary-model"] } : {}),
      };
      saveState({
        ...context.paths,
        config: state.config,
        secrets: state.secrets,
        dryRun: globalFlags.dryRun,
      });
      return { data: { sessionSync: state.config.sessionSync, dry_run: Boolean(globalFlags.dryRun) } };
    },
  });
}

function setSyncEnabled(context, enabled, dryRun) {
  const state = loadStateOrThrow(context.paths);
  state.config.sessionSync = {
    ...(state.config.sessionSync || {}),
    enabled,
  };
  saveState({
    ...context.paths,
    config: state.config,
    secrets: state.secrets,
    dryRun,
  });
  return { data: { sessionSync: state.config.sessionSync, dry_run: Boolean(dryRun) } };
}