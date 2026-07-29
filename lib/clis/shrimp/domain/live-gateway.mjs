export async function fetchHealth({ host = "127.0.0.1", port = 8787, timeoutMs = 1200 } = {}) {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, status: response.status };
    const body = await response.json();
    return { ok: true, status: response.status, body };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}