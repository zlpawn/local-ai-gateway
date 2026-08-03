import type { AppConfig, AnalyticsResponse } from "./types";

export async function getConfig(): Promise<AppConfig | null> {
  try {
    const res = await fetch("/v1/config");
    if (res.ok) return await res.json();
  } catch {
    console.warn("Failed to fetch config.");
  }
  return null;
}

export async function saveConfig(config: AppConfig): Promise<boolean> {
  try {
    const res = await fetch("/v1/config/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getAnalyticsData(params: Record<string, string>): Promise<AnalyticsResponse | null> {
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`/v1/analytics/token-usage?${qs}`);
    if (res.ok) return await res.json();
  } catch {
    console.warn("Failed to fetch analytics.");
  }
  return null;
}

export async function loadSyncStatus(): Promise<unknown> {
  try {
    const res = await fetch("/v1/sync/status");
    if (res.ok) return await res.json();
  } catch {
    /* ignore */
  }
  return null;
}

export async function configureSync(payload: Record<string, unknown>): Promise<unknown> {
  try {
    const res = await fetch("/v1/sync/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return await res.json();
  } catch {
    /* ignore */
  }
  return null;
}

export async function fetchJson(url: string, options?: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(url, options);
    if (res.ok) return await res.json();
  } catch {
    /* ignore */
  }
  return null;
}
