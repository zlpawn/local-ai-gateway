const GATEWAY_DEFAULT = "http://127.0.0.1:8788";
const HEARTBEAT_INTERVAL_MS = 25_000;
const RETRY_INTERVAL_MS = 15_000;

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
  } catch (e) {
    setTimeout(register, RETRY_INTERVAL_MS);
  }
}

let heartbeatTimer = null;
function scheduleHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
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

// Use alarms API for reliable heartbeat in MV3 (Service Worker can be killed)
chrome.alarms.create("heartbeat", { periodInMinutes: 0.5 }); // every 30s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "heartbeat") {
    sendHeartbeat();
  }
});

// Register on startup/install
chrome.runtime.onInstalled.addListener(() => register());
chrome.runtime.onStartup.addListener(() => register());

// Also register on script load (covers browser restart without onStartup)
register();
