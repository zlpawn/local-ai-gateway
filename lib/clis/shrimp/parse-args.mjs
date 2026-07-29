const GLOBAL_FLAGS_WITH_VALUE = new Set([
  "--format",
  "--data-dir",
  "--root",
  "--runtime-dir",
  "--port",
  "--config-file",
  "--secrets-file",
  "--timeout-ms",
]);

export function parseGlobalFlags(argv = []) {
  const flags = {
    format: "json",
    dryRun: false,
    yes: false,
    force: false,
    help: false,
    testMode: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (token === "--json") { flags.format = "json"; continue; }
    if (token === "--human" || token === "--pretty") { flags.format = "pretty"; continue; }
    if (token === "--dry-run") { flags.dryRun = true; continue; }
    if (token === "--yes" || token === "-y") { flags.yes = true; continue; }
    if (token === "--force") { flags.force = true; continue; }
    if (token === "--help" || token === "-h") { flags.help = true; continue; }
    if (token === "--test") { flags.testMode = true; continue; }
    if (token === "--no-color") { flags.noColor = true; continue; }
    if (GLOBAL_FLAGS_WITH_VALUE.has(token)) {
      const value = argv[i + 1];
      if (value == null || String(value).startsWith("-")) {
        const err = new Error(`Missing value for ${token}`);
        err.type = "usage";
        err.code = "missing_flag_value";
        throw err;
      }
      i += 1;
      if (token === "--format") flags.format = value;
      else if (token === "--data-dir") flags.dataDir = value;
      else if (token === "--root") flags.root = value;
      else if (token === "--runtime-dir") flags.runtimeDir = value;
      else if (token === "--port") flags.port = Number.parseInt(value, 10);
      else if (token === "--config-file") flags.configFile = value;
      else if (token === "--secrets-file") flags.secretsFile = value;
      else if (token === "--timeout-ms") flags.timeoutMs = Number.parseInt(value, 10);
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) {
      const eq = token.indexOf("=");
      rest.push(token.slice(0, eq), token.slice(eq + 1));
      continue;
    }
    rest.push(token);
  }
  return { flags, rest };
}

export function parseCommandFlags(argv = [], { boolean = [], value = [] } = {}) {
  const boolSet = new Set(boolean.map((x) => x.replace(/^--/, "")));
  const valueSet = new Set(value.map((x) => x.replace(/^--/, "")));
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!String(token).startsWith("-")) {
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
      const next = argv[i + 1];
      if (next == null || String(next).startsWith("-")) {
        const err = new Error(`Missing value for --${name}`);
        err.type = "usage";
        err.code = "missing_flag_value";
        err.fields = [name];
        throw err;
      }
      flags[name] = next;
      i += 1;
      continue;
    }
    flags[name] = true;
  }
  return { flags, positionals };
}

export function splitCommandPath(rest = []) {
  const path = [];
  let i = 0;
  while (i < rest.length && !String(rest[i]).startsWith("-")) {
    path.push(rest[i]);
    i += 1;
  }
  return { path, args: rest.slice(i) };
}

export function requireFields(flags, fields = []) {
  const missing = fields.filter((f) => flags[f] == null || flags[f] === "");
  if (missing.length) {
    const err = new Error(`Missing required fields: ${missing.join(", ")}`);
    err.type = "validation";
    err.code = "missing_fields";
    err.fields = missing;
    err.hint = `Provide ${missing.map((f) => `--${f}`).join(", ")}`;
    throw err;
  }
}