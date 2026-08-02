// v1internal upstream client. Mirrors AG proxy/upstream/client.rs:
// multi-endpoint fallback (prod->daily->sandbox), 403 x-goog-user-project
// downgrade retry, and the official client fingerprint headers.
import crypto from "node:crypto";
import os from "node:os";
import { V1INTERNAL_BASE_URLS } from "./constants.mjs";

export const ANTIGRAVITY_VERSION = "4.3.0";

const PLATFORM_UA = process.platform === "darwin"
  ? "Macintosh; Intel Mac OS X 10_15_7"
  : process.platform === "win32"
    ? "Windows NT 10.0; Win64; x64"
    : "X11; Linux x86_64";

export const UPSTREAM_USER_AGENT =
  `Antigravity/${ANTIGRAVITY_VERSION} (${PLATFORM_UA}) Chrome/132.0.6834.160 Electron/39.2.3`;

export const SESSION_ID = crypto.randomUUID();

let cachedMachineId = null;
export function getMachineId() {
  if (cachedMachineId) return cachedMachineId;
  const home = os.userInfo().homedir || os.homedir();
  cachedMachineId = crypto
    .createHash("sha256")
    .update(`${os.hostname()}:${home}`)
    .digest("hex")
    .slice(0, 32);
  return cachedMachineId;
}

export function buildUrl(base, method, query) {
  return query ? `${base}:${method}?${query}` : `${base}:${method}`;
}

export function shouldTryNextEndpoint(status) {
  return status === 408 || status === 404 || (status >= 500 && status < 600);
}

function buildHeaders({ accessToken, project }) {
  const h = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": UPSTREAM_USER_AGENT,
    "x-client-name": "antigravity",
    "x-client-version": ANTIGRAVITY_VERSION,
    "x-machine-id": getMachineId(),
    "x-vscode-sessionid": SESSION_ID,
  };
  if (project && project !== "test-project" && project !== "project-id") {
    h["x-goog-user-project"] = project;
  }
  return h;
}

// Core v1internal call: endpoint fallback (408/404/5xx) + 403 project-header
// downgrade. Non-retryable responses are returned to the caller (loadCodeAssist/
// generateContent decide whether to throw). Only 403+project triggers pass 2.
export async function callV1Internal({
  method,
  accessToken,
  body,
  project = null,
  query = null,
  fetchImpl = fetch,
}) {
  let lastError = null;
  let attemptDowngrade = false;
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1 && !attemptDowngrade) break;
    const headers = buildHeaders({ accessToken, project });
    if (pass === 1) delete headers["x-goog-user-project"];
    for (const base of V1INTERNAL_BASE_URLS) {
      const url = buildUrl(base, method, query);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        if (res.ok) return res;
        if (res.status === 403 && pass === 0 && headers["x-goog-user-project"]) {
          attemptDowngrade = true;
          break; // retry without x-goog-user-project
        }
        if (shouldTryNextEndpoint(res.status)) {
          lastError = new Error(`${method} ${base} returned ${res.status}`);
          continue; // next endpoint
        }
        return res; // non-retryable, surface to caller
      } catch (e) {
        lastError = e;
        continue;
      }
    }
  }
  throw lastError || new Error(`${method} failed across all endpoints`);
}

export async function loadCodeAssist({ accessToken, fetchImpl = fetch }) {
  const res = await callV1Internal({
    method: "loadCodeAssist",
    accessToken,
    body: { metadata: { ideType: "ANTIGRAVITY" } },
    fetchImpl,
  });
  if (!res.ok) {
    throw new Error(`loadCodeAssist failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  const project = data.cloudaicompanionProject;
  if (!project) {
    throw new Error(
      "loadCodeAssist returned no cloudaicompanionProject (account may be ineligible)",
    );
  }
  return { project, raw: data };
}

// Official Antigravity model catalog endpoint (same family as AG-Manager quota.rs).
// Fallback order is already handled by callV1Internal base URL list.
export async function fetchAvailableModels({ accessToken, project = null, fetchImpl = fetch } = {}) {
  const res = await callV1Internal({
    method: "fetchAvailableModels",
    accessToken,
    project,
    body: project ? { project } : {},
    fetchImpl,
  });
  if (!res.ok) {
    throw new Error(`fetchAvailableModels failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export async function generateContent({ accessToken, project, body, fetchImpl = fetch }) {
  const res = await callV1Internal({
    method: "generateContent",
    accessToken,
    body,
    project,
    fetchImpl,
  });
  if (!res.ok) {
    throw new Error(`generateContent failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export async function streamGenerateContent({ accessToken, project, body, fetchImpl = fetch }) {
  const res = await callV1Internal({
    method: "streamGenerateContent",
    accessToken,
    body,
    project,
    query: "alt=sse",
    fetchImpl,
  });
  if (!res.ok || !res.body) {
    throw new Error(`streamGenerateContent failed (${res.status}): ${await res.text()}`);
  }
  return res.body;
}