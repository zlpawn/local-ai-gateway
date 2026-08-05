const GATEWAY_DEFAULT = "http://127.0.0.1:8788";
const HEARTBEAT_INTERVAL_MS = 60_000;
const RETRY_INTERVAL_MS = 30_000;

async function getGatewayUrl() {
  const result = await chrome.storage.local.get("gatewayUrl");
  return result.gatewayUrl || GATEWAY_DEFAULT;
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
    scheduleHeartbeat();
  } catch (e) {
    setTimeout(register, RETRY_INTERVAL_MS);
  }
}

let heartbeatTimer = null;
function scheduleHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
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
  }, HEARTBEAT_INTERVAL_MS);
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

// Register on startup
register();