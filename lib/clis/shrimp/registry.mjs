import {
  CliError,
  errorEnvelope,
  exitCodeForError,
  successEnvelope,
} from "./protocol.mjs";
import { parseGlobalFlags, splitCommandPath } from "./parse-args.mjs";

export function createRegistry() {
  const commands = new Map();

  function register(descriptor) {
    if (!descriptor?.name) throw new Error("command name is required");
    commands.set(descriptor.name, {
      description: "",
      mutating: false,
      dryRun: false,
      params: [],
      ...descriptor,
    });
  }

  function get(name) {
    return commands.get(name) || null;
  }

  function list() {
    return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function resolveCommand(pathParts = []) {
    if (!pathParts.length) return null;
    // longest match first: endpoint add -> endpoint.add
    for (let len = pathParts.length; len >= 1; len -= 1) {
      const name = pathParts.slice(0, len).join(".");
      if (commands.has(name)) {
        return {
          descriptor: commands.get(name),
          name,
          remainingPath: pathParts.slice(len),
        };
      }
    }
    return null;
  }

  function toSchema(name) {
    if (name) {
      const cmd = commands.get(name);
      if (!cmd) return null;
      return {
        name: cmd.name,
        description: cmd.description,
        mutating: Boolean(cmd.mutating),
        dryRun: Boolean(cmd.dryRun),
        params: cmd.params || [],
      };
    }
    return list().map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      mutating: Boolean(cmd.mutating),
      dryRun: Boolean(cmd.dryRun),
      params: cmd.params || [],
    }));
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

    if (!rest.length) rest = ["help"];
    const { path, args } = splitCommandPath(rest);
    const resolved = resolveCommand(path);
    if (!resolved) {
      const envelope = errorEnvelope({
        command: path.join("."),
        error: {
          type: "usage",
          code: "unknown_command",
          message: `Unknown command: ${path.join(" ") || "(empty)"}`,
          hint: "Run `shrimp schema` or `shrimp help`",
        },
        meta: { dry_run: globalFlags.dryRun },
      });
      return { ok: false, envelope, exitCode: EXIT_USAGE(), format: globalFlags.format };
    }

    const { descriptor, name, remainingPath } = resolved;
    if (globalFlags.dryRun && !descriptor.dryRun && descriptor.mutating) {
      // still allow dry-run if command opts in via dryRun=true; otherwise ignore only for non-mutating
    }
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
        registry: { get, list, toSchema, register },
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

  return { register, get, list, toSchema, dispatch, resolveCommand };
}

function EXIT_USAGE() {
  return 2;
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