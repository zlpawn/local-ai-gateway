import { runAgentReach, getInstalledChannels } from "./detector.mjs";

/**
 * Content fetcher - uses agent-reach get to retrieve content from any platform.
 *
 * Returns a unified format regardless of source platform:
 *   { title, text, source, url, type, metadata }
 *
 * For video platforms (YouTube, Bilibili): returns transcript text.
 * For text platforms (Reddit, V2EX): returns post content.
 * For future: article/post/code content.
 */

/**
 * Fetch content from a URL using agent-reach.
 *
 * Strategy:
 * 1. Get installed channels
 * 2. Try `agent-reach get <url> --json` (agent-reach auto-routes to the right channel)
 * 3. Parse response into unified format
 *
 * @param {string} url - The URL to fetch content from
 * @param {{signal?: AbortSignal}} opts
 * @returns {Promise<{title, text, source, url, type, metadata} | null>}
 */
export async function fetchContent(url, { signal } = {}) {
  const channels = await getInstalledChannels();
  if (channels.length === 0) return null;

  // agent-reach get auto-detects the channel from the URL
  // But it needs a target (channel name). We try each installed channel
  // until one succeeds.
  for (const channel of channels) {
    if (signal?.aborted) return null;

    const result = await runAgentReachGet(channel, url, { signal });
    if (result && result.text) {
      return result;
    }
  }

  return null;
}

/**
 * Run `agent-reach get <channel> <url> --json` and parse the response.
 */
async function runAgentReachGet(channel, url, { signal } = {}) {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve) => {
    const proc = spawn("agent-reach", ["get", channel, url, "--json"], {
      timeout: 60000,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("error", () => resolve(null));

    const abortHandler = () => {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    };
    if (signal) {
      if (signal.aborted) { proc.kill("SIGTERM"); }
      else { signal.addEventListener("abort", abortHandler, { once: true }); }
    }

    proc.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", abortHandler);
      if (code !== 0) { resolve(null); return; }

      try {
        const data = JSON.parse(stdout);
        const item = data.items?.[0];
        if (!item) { resolve(null); return; }

        resolve({
          title: item.title || data.query || "",
          text: item.text || "",
          source: data.channel || channel,
          url: item.url || url,
          type: detectContentType(data.channel || channel, item),
          metadata: {
            author: item.author || "",
            published_at: item.published_at || "",
            engagement: item.engagement || null,
            language: item.language || "",
            children: item.children || [],
          },
        });
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Detect content type based on channel and item structure.
 */
function detectContentType(channel, item) {
  // Video platforms return transcripts
  if (["youtube", "bilibili", "xiaoyuzhou"].includes(channel)) {
    return "transcript";
  }
  // Text-based platforms
  if (["reddit", "v2ex"].includes(channel)) {
    return "post";
  }
  if (["twitter", "facebook", "instagram", "xiaohongshu"].includes(channel)) {
    return "social";
  }
  if (["github"].includes(channel)) {
    return "code";
  }
  if (["rss", "web"].includes(channel)) {
    return "article";
  }
  return "text";
}
