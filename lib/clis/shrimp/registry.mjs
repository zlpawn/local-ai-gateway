import {
  CliError,
  errorEnvelope,
  exitCodeForError,
  successEnvelope,
} from "./protocol.mjs";
import { parseGlobalFlags, splitCommandPath } from "./parse-args.mjs";

export function createRegistry() {
  const commands = new Map();
  const aliases = new Map(); // alias -> canonical dotted name

  function register(descriptor) {
    if (!descriptor?.name) throw new Error("command name is required");
    const entry = {
      description: "",
      mutating: false,
      dryRun: false,
      params: [],
      aliases: [],
      group: "general",
      ...descriptor,
    };
    commands.set(entry.name, entry);
    for (const alias of entry.aliases || []) {
      aliases.set(normalizeName(alias), entry.name);
    }
    // also allow space form of dotted name as implicit alias
    aliases.set(entry.name.replaceAll(".", " "), entry.name);
  }

  function normalizeName(name = "") {
    return String(name).trim().replaceAll(".", " ").replace(/\s+/g, " ").toLowerCase();
  }

  function get(name) {
    const key = String(name || "");
    if (commands.has(key)) return commands.get(key);
    const viaAlias = aliases.get(normalizeName(key));
    return viaAlias ? commands.get(viaAlias) : null;
  }

  function list() {
    return [...commands.values()]
      .filter((c) => !c.hidden)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function resolveCommand(pathParts = []) {
    if (!pathParts.length) return null;
    // longest match first against dotted names and aliases
    for (let len = pathParts.length; len >= 1; len -= 1) {
      const spaced = pathParts.slice(0, len).join(" ").toLowerCase();
      const dotted = pathParts.slice(0, len).join(".");
      const canonical = aliases.get(spaced) || (commands.has(dotted) ? dotted : null);
      if (canonical && commands.has(canonical)) {
        return {
          descriptor: commands.get(canonical),
          name: canonical,
          remainingPath: pathParts.slice(len),
        };
      }
    }
    return null;
  }

  function toSchema(name) {
    if (name) {
      const cmd = get(name.includes(" ") ? name : name);
      const resolved = cmd || get(String(name).replaceAll(" ", "."));
      if (!resolved) return null;
      return {
        name: resolved.name,
        description: resolved.description,
        group: resolved.group || "general",
        aliases: resolved.aliases || [],
        mutating: Boolean(resolved.mutating),
        dryRun: Boolean(resolved.dryRun),
        params: resolved.params || [],
      };
    }
    return list().map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      group: cmd.group || "general",
      aliases: cmd.aliases || [],
      mutating: Boolean(cmd.mutating),
      dryRun: Boolean(cmd.dryRun),
      params: cmd.params || [],
    }));
  }

  function helpData() {
    const groups = new Map();
    for (const cmd of list()) {
      const g = cmd.group || "general";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({
        name: cmd.name.replaceAll(".", " "),
        description: cmd.description,
        aliases: (cmd.aliases || []).slice(0, 4),
      });
    }
    return {
      usage: "shrimp <command> [args] [flags]",
      tips: [
        "Default output is JSON for agents. Use --format pretty for humans.",
        "Global flags can appear before or after the command.",
        "Install commands: trailing args are the shell command; prefer: shrimp skill install -- <cmd...>",
        "Cross-platform: avoid shell-specific syntax; quote args with spaces.",
        "Windows PowerShell: quote dashed install flags or use --command \"...\".",
      ],
      groups: [...groups.entries()].map(([name, commands]) => ({ name, commands })),
    };
  }

  async function dispatch(argv = [], context = {}) {
    const started = Date.now();
    let globalFlags = { format: "json", dryRun: false };
    let rest = argv;
    try {
      const parsed = parseGlobalFlags(argv);
      globalFlags = { ...globalFlags, ...parsed.flags };
      rest = parsed.rest;
    } catch (error) {
      const envelope = errorEnvelope({
        command: "",
        error: {
          type: error.type || "usage",
          code: error.code || "invalid_args",
          message: error.message,
          fields: error.fields,
          hint: error.hint,
        },
        meta: { dry_run: false },
      });
      return { ok: false, envelope, exitCode: exitCodeForError(envelope.error), format: globalFlags.format };
    }

    if (!rest.length || globalFlags.help && rest.length === 0) rest = ["help"];
    const { path, args } = splitCommandPath(rest);
    if (globalFlags.help && path.length) {
      // shrimp --help endpoint add  OR shrimp endpoint add --help
      const resolvedHelp = resolveCommand(path);
      if (resolvedHelp) {
        const envelope = successEnvelope({
          command: "help",
          data: toSchema(resolvedHelp.name),
          meta: { dry_run: false, duration_ms: Date.now() - started },
        });
        return { ok: true, envelope, exitCode: 0, format: globalFlags.format === "json" && process.stdout.isTTY ? "pretty" : globalFlags.format };
      }
    }

    const resolved = resolveCommand(path);
    if (!resolved) {
      const envelope = errorEnvelope({
        command: path.join("."),
        error: {
          type: "usage",
          code: "unknown_command",
          message: `Unknown command: ${path.join(" ") || "(empty)"}`,
          hint: "Run `shrimp help` or `shrimp schema`",
        },
        meta: { dry_run: globalFlags.dryRun },
      });
      return { ok: false, envelope, exitCode: 2, format: globalFlags.format };
    }

    const { descriptor, name, remainingPath } = resolved;
    if (globalFlags.dryRun && descriptor.mutating && descriptor.dryRun === false) {
      const envelope = errorEnvelope({
        command: name,
        error: {
          type: "usage",
          code: "dry_run_unsupported",
          message: `Command ${name} does not support --dry-run`,
        },
        meta: { dry_run: true },
      });
      return { ok: false, envelope, exitCode: exitCodeForError(envelope.error), format: globalFlags.format };
    }

    try {
      const result = await descriptor.handler({
        args: [...remainingPath, ...args],
        flags: globalFlags,
        context,
        registry: { get, list, toSchema, register, helpData, aliases },
      });
      const envelope = successEnvelope({
        command: name,
        data: result?.data ?? result ?? {},
        meta: {
          dry_run: Boolean(globalFlags.dryRun),
          duration_ms: Date.now() - started,
          ...(result?.meta || {}),
        },
        next: result?.next || [],
      });
      return { ok: true, envelope, exitCode: 0, format: globalFlags.format };
    } catch (error) {
      const normalized = normalizeError(error);
      const envelope = errorEnvelope({
        command: name,
        error: normalized,
        meta: {
          dry_run: Boolean(globalFlags.dryRun),
          duration_ms: Date.now() - started,
        },
      });
      return {
        ok: false,
        envelope,
        exitCode: exitCodeForError(normalized),
        format: globalFlags.format,
      };
    }
  }

  return { register, get, list, toSchema, dispatch, resolveCommand, helpData, aliases };
}

function normalizeError(error) {
  if (error instanceof CliError) return error.toJSON();
  if (error && typeof error === "object") {
    return {
      type: error.type || (error.code === "ENOENT" ? "not_found" : "internal"),
      code: error.code || "internal_error",
      message: error.message || String(error),
      fields: error.fields,
      hint: error.hint,
      retryable: Boolean(error.retryable),
      details: error.details,
    };
  }
  return {
    type: "internal",
    code: "internal_error",
    message: String(error),
    retryable: false,
  };
}