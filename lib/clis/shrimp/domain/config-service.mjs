import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  GatewayConfigError,
  loadGatewayState,
  saveGatewayState,
  validateGatewayConfig,
} from "../../../config/gateway-config-store.mjs";
import { formatSecretState, CliError } from "../protocol.mjs";

function writeSecretsFile(secretsPath, secrets) {
  const dir = path.dirname(secretsPath);
  fs.mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify(secrets || { api_keys: {} }, null, 2)}\n`;
  const tmp = `${secretsPath}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, secretsPath);
}

export async function getConfig({ configPath, secretsPath }) {
  const state = loadGatewayState({ configPath, secretsPath });
  const secrets = state.secrets || { api_keys: {} };
  return {
    config: state.config,
    secret_states: Object.fromEntries(
      Object.entries(secrets.api_keys || {}).map(([id, value]) => [id, formatSecretState(value)]),
    ),
    paths: { configPath, secretsPath },
  };
}

export async function validateConfig({ configPath, secretsPath }) {
  try {
    const state = loadGatewayState({ configPath, secretsPath });
    return {
      valid: true,
      path: configPath,
      clients: Object.keys(state.config.clients || {}),
      endpoint_count: Object.values(state.config.clients || {}).reduce(
        (n, client) => n + (client.endpoints?.length || 0),
        0,
      ),
    };
  } catch (error) {
    if (error instanceof GatewayConfigError) {
      return {
        valid: false,
        path: configPath,
        issues: error.issues || [{ message: error.message }],
      };
    }
    throw error;
  }
}

export async function restoreTemplate({ packageRoot, dataDir, yes = false, dryRun = false }) {
  const target = path.join(dataDir, "gateway.config.json");
  const template = path.join(packageRoot, "gateway.config.example.json");
  let exists = false;
  try {
    await fsPromises.access(target);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists && !yes) {
    throw new CliError({
      type: "conflict",
      code: "target_exists",
      message: `Refusing to overwrite existing ${target} without --yes`,
      hint: "Re-run with --yes to restore the public template",
    });
  }
  if (dryRun) {
    return { restored: false, dry_run: true, target, template };
  }
  await fsPromises.mkdir(dataDir, { recursive: true });
  await fsPromises.copyFile(template, target);
  return { restored: true, target };
}

export function loadStateOrThrow({ configPath, secretsPath }) {
  try {
    return loadGatewayState({ configPath, secretsPath });
  } catch (error) {
    if (error instanceof GatewayConfigError) {
      throw new CliError({
        type: "validation",
        code: "invalid_gateway_config",
        message: error.message,
        details: error.issues,
      });
    }
    throw error;
  }
}

export function saveState({ configPath, secretsPath, config, secrets, dryRun = false }) {
  const nextSecrets = secrets || { api_keys: {} };
  if (dryRun) {
    const issues = validateGatewayConfig(config, { allowModelConflicts: true });
    if (issues.length) {
      throw new CliError({
        type: "validation",
        code: "invalid_gateway_config",
        message: issues.map((i) => i.message).join("\n"),
        details: issues,
      });
    }
    return { config, secrets: nextSecrets, dry_run: true };
  }

  // Persist secrets first so saveGatewayState's disk read sees the latest keys.
  writeSecretsFile(secretsPath, nextSecrets);

  try {
    const saved = saveGatewayState({
      configPath,
      secretsPath,
      config,
    });
    return { ...saved, secrets: nextSecrets, dry_run: false };
  } catch (error) {
    if (error instanceof GatewayConfigError) {
      throw new CliError({
        type: "validation",
        code: "invalid_gateway_config",
        message: error.message,
        details: error.issues,
      });
    }
    throw error;
  }
}