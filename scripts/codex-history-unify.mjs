import { restoreCodexHistoryBackup, unifyCodexHistory } from "../lib/codex/history-unify.mjs";

const args = process.argv.slice(2);
const shouldApply = args.includes("--apply");
const shouldDryRun = args.includes("--dry-run") || !shouldApply;
const allowRunningCodex = args.includes("--allow-running-codex");
const restoreIndex = args.indexOf("--restore");
const restoreRoot = restoreIndex >= 0 ? args[restoreIndex + 1] : "";

const codexHome = valueAfter("--codex-home") || process.env.CODEX_HOME || "";
const targetProvider = valueAfter("--target") || "custom";
const sourceProviders = valueAfter("--sources") || "openai,volcengine-agent-plan,ccswitch_gateway,deepseek";

try {
  if (restoreRoot) {
    const result = restoreCodexHistoryBackup(restoreRoot, {
      codexHome: codexHome || undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  const result = unifyCodexHistory({
    dryRun: shouldDryRun,
    allowRunningCodex,
    codexHome: codexHome || undefined,
    targetProvider,
    sourceProviders,
  });

  console.log(JSON.stringify(result, null, 2));
  if (shouldDryRun) {
    console.log("");
    console.log("Dry run only. To apply, run:");
    console.log("  npm run codex:history:apply");
  } else {
    console.log("");
    console.log("Restore command:");
    console.log(`  node scripts/codex-history-unify.mjs --restore "${result.backupRoot}"`);
  }
} catch (error) {
  if (error?.code === "codex_running") {
    console.error(error.message);
    for (const line of error.running || []) console.error(`  ${line}`);
    console.error("If you are absolutely sure this is safe, rerun with --allow-running-codex.");
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

function valueAfter(name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  return args[index + 1] || "";
}
