const SECRET_KEY_RE = /^(api[_-]?key|authorization|access_token|refresh_token|client_secret|password|secret|token)$/i;

export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  VALIDATION: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  AUTH: 5,
  RUNTIME: 6,
  EXTERNAL: 7,
};

export function successEnvelope({ command, data = {}, meta = {}, next = [] } = {}) {
  return {
    ok: true,
    command: command || "",
    data,
    meta: { dry_run: false, ...meta },
    next: Array.isArray(next) ? next : [],
  };
}

export function errorEnvelope({ command, error, meta = {} } = {}) {
  const err = error || {};
  return {
    ok: false,
    command: command || "",
    error: {
      type: err.type || "internal",
      code: err.code || "internal_error",
      message: err.message || "Unknown error",
      fields: err.fields,
      hint: err.hint,
      retryable: Boolean(err.retryable),
      ...(err.details ? { details: err.details } : {}),
    },
    meta: { dry_run: false, ...meta },
  };
}

export function formatSecretState(value) {
  if (value == null || value === "") return "missing";
  const text = String(value);
  if (text.startsWith("env:")) return text;
  return "stored";
}

function shouldRedactKey(key) {
  return SECRET_KEY_RE.test(String(key));
}

export function redactSecrets(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (shouldRedactKey(key) && val != null && val !== "") {
      if (typeof val === "string" && val.startsWith("env:")) out[key] = val;
      else out[key] = "***";
      continue;
    }
    out[key] = redactSecrets(val, seen);
  }
  return out;
}

function printPretty(envelope) {
  if (!envelope?.ok) {
    return [
      `ERROR ${envelope.command || ""}`.trim(),
      `${envelope.error?.type}/${envelope.error?.code}: ${envelope.error?.message}`,
      envelope.error?.hint ? `hint: ${envelope.error.hint}` : "",
      envelope.error?.fields?.length ? `fields: ${envelope.error.fields.join(", ")}` : "",
    ].filter(Boolean).join("\n");
  }

  if (envelope.command === "help" && envelope.data?.groups) {
    const lines = ["shrimp — agent-native local AI gateway CLI", "", `Usage: ${envelope.data.usage}`, ""];
    for (const tip of envelope.data.tips || []) lines.push(`- ${tip}`);
    lines.push("");
    for (const group of envelope.data.groups || []) {
      lines.push(String(group.name || "general").toUpperCase());
      for (const cmd of group.commands || []) {
        const alias = cmd.aliases?.length ? `  (alias: ${cmd.aliases.join(", ")})` : "";
        lines.push(`  ${String(cmd.name).padEnd(28)} ${cmd.description || ""}${alias}`);
      }
      lines.push("");
    }
    return lines.join("\n").trimEnd();
  }

  if (envelope.command === "schema" && envelope.data?.name) {
    const p = envelope.data;
    return [
      `command: ${String(p.name).replaceAll(".", " ")}`,
      p.description || "",
      p.aliases?.length ? `aliases: ${p.aliases.join(", ")}` : "",
      `mutating: ${Boolean(p.mutating)}  dry-run: ${Boolean(p.dryRun)}`,
      ...(p.params || []).map((x) => `  --${x.name}${x.required ? " (required)" : ""}  ${x.description || x.type || ""}`),
    ].filter(Boolean).join("\n");
  }

  return [
    `ok=true command=${envelope.command}`,
    envelope.data && Object.keys(envelope.data).length ? JSON.stringify(redactSecrets(envelope.data), null, 2) : "",
    envelope.next?.length ? `next=${JSON.stringify(envelope.next)}` : "",
  ].filter(Boolean).join("\n");
}

function stringify(envelope, format = "json") {
  const safe = redactSecrets(envelope);
  if (format === "pretty") return printPretty(safe);
  return JSON.stringify(safe, null, 2);
}

export function printSuccess(io, envelope, format = "json") {
  const text = stringify(envelope, format);
  if (io?.log) io.log(text);
  else console.log(text);
}

export function printError(io, envelope, format = "json") {
  const text = stringify(envelope, format);
  if (io?.error) io.error(text);
  else console.error(text);
}

export function exitCodeForError(error = {}) {
  switch (error.type) {
    case "usage":
      return EXIT.USAGE;
    case "validation":
      return EXIT.VALIDATION;
    case "not_found":
      return EXIT.NOT_FOUND;
    case "conflict":
      return EXIT.CONFLICT;
    case "auth":
      return EXIT.AUTH;
    case "runtime":
      return EXIT.RUNTIME;
    case "external":
      return EXIT.EXTERNAL;
    default:
      return EXIT.INTERNAL;
  }
}

export class CliError extends Error {
  constructor({ type = "internal", code = "internal_error", message, fields, hint, retryable = false, details } = {}) {
    super(message || code);
    this.name = "CliError";
    this.type = type;
    this.code = code;
    this.fields = fields;
    this.hint = hint;
    this.retryable = retryable;
    this.details = details;
  }

  toJSON() {
    return {
      type: this.type,
      code: this.code,
      message: this.message,
      fields: this.fields,
      hint: this.hint,
      retryable: this.retryable,
      details: this.details,
    };
  }
}