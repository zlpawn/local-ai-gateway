const GATEWAY_DEFAULT = "http://127.0.0.1:8788";
const HEARTBEAT_INTERVAL_MS = 25_000;
const RETRY_INTERVAL_MS = 15_000;
const CLAIM_INTERVAL_MS = 2_000;

async function getGatewayUrl() {
  const result = await chrome.storage.local.get("gatewayUrl");
  return result.gatewayUrl || GATEWAY_DEFAULT;
}

async function sendHeartbeat() {
  const url = await getGatewayUrl();
  try {
    await fetch(`${url}/v1/extensions/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: chrome.runtime.id }),
    });
  } catch {
    /* silent retry, next heartbeat will try again */
  }
}

async function register() {
  const url = await getGatewayUrl();
  try {
    const resp = await fetch(`${url}/v1/extensions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: chrome.runtime.id,
        name: "Leo cookie.txt Locally",
        version: chrome.runtime.getManifest().version,
        capabilities: ["cookies"],
        permissions: chrome.runtime.getManifest().permissions || [],
      }),
    });
    if (!resp.ok) throw new Error(`register failed: ${resp.status}`);
    // Send immediate heartbeat so online status shows right away
    await sendHeartbeat();
    scheduleHeartbeat();
    scheduleClaimLoop();
  } catch (e) {
    setTimeout(register, RETRY_INTERVAL_MS);
  }
}

let heartbeatTimer = null;
function scheduleHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

let claimInFlight = false;
let claimTimer = null;

async function claimAndRun() {
  if (claimInFlight) return;
  claimInFlight = true;
  try {
    const url = await getGatewayUrl();
    const resp = await fetch(`${url}/v1/extension-tasks/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extension_id: chrome.runtime.id,
        capabilities: ["cookies"],
        limit: 1,
      }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const tasks = data.tasks || [];
    for (const task of tasks) {
      await executeTask(url, task);
    }
  } catch {
    /* silent - gateway may be down */
  } finally {
    claimInFlight = false;
  }
}

async function postTaskUpdate(gatewayUrl, taskId, action, body) {
  const resp = await fetch(`${gatewayUrl}/v1/extension-tasks/${encodeURIComponent(taskId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Best-effort: if complete/fail cannot reach gateway, task stays running until TTL.
  if (!resp.ok) {
    console.warn(`[cookie-ext] ${action} failed`, taskId, resp.status);
  }
  return resp;
}

async function executeTask(gatewayUrl, task) {
  if (!task || !task.id) return;
  if (task.type !== "cookies.export") {
    await postTaskUpdate(gatewayUrl, task.id, "fail", {
      extension_id: chrome.runtime.id,
      error: { type: "unsupported_task_type", message: `Unsupported task type: ${task.type}` },
    });
    return;
  }

  const domain = (task.payload && task.payload.domain) || "";
  let cookies = [];
  try {
    cookies = await chrome.cookies.getAll({ domain });
  } catch (err) {
    await postTaskUpdate(gatewayUrl, task.id, "fail", {
      extension_id: chrome.runtime.id,
      error: {
        type: "extension_error",
        message: err && err.message ? err.message : "Failed to read cookies",
      },
    });
    return;
  }

  if (!cookies || cookies.length === 0) {
    await postTaskUpdate(gatewayUrl, task.id, "fail", {
      extension_id: chrome.runtime.id,
      error: { type: "no_cookies", message: `No cookies for domain ${domain}` },
    });
    return;
  }

  await postTaskUpdate(gatewayUrl, task.id, "complete", {
    extension_id: chrome.runtime.id,
    cookies,
  });
}

function scheduleClaimLoop() {
  if (claimTimer) clearInterval(claimTimer);
  claimTimer = setInterval(claimAndRun, CLAIM_INTERVAL_MS);
  claimAndRun();
}

// Listen for external messages from the gateway page (Path A)
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "getCookies") {
    const domain = msg.domain || "";
    chrome.cookies.getAll({ domain }, (cookies) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ cookies });
      }
    });
    return true; // async response
  }
  sendResponse({ error: "unknown action" });
  return false;
});

// Re-register when gateway URL changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.gatewayUrl) {
    register();
  }
});

// Use alarms API for reliable heartbeat/claim wakeups in MV3
chrome.alarms.create("heartbeat", { periodInMinutes: 0.5 }); // every 30s
chrome.alarms.create("claim", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "heartbeat") {
    sendHeartbeat();
  }
  if (alarm.name === "claim" || alarm.name === "heartbeat") {
    claimAndRun();
  }
});

// Register on startup/install
chrome.runtime.onInstalled.addListener(() => register());
chrome.runtime.onStartup.addListener(() => register());

// Also register on script load (covers browser restart without onStartup)
register();
