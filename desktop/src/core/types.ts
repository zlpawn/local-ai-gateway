export interface AppConfig {
  server: { host: string; port: number };
  clients: Record<string, ClientConfig>;
  codex_model_catalog?: { path?: string; path_posix?: string };
  custom_prices?: CustomPrice[];
  [key: string]: unknown;
}

export interface ClientConfig {
  endpoints: Endpoint[];
  model_slots?: Record<string, string>;
  [key: string]: unknown;
}

export interface Endpoint {
  id?: string;
  name: string;
  type: string;
  base_url: string;
  api_key: string;
  models: string[];
  model_mapping?: Record<string, string>;
  is_default?: boolean;
  enabled?: boolean;
  purpose?: string;
  proxy?: string;
  [key: string]: unknown;
}

export type ToolsView = "cards" | "embedding" | "classification-metrics"
  | "antigravity-subscribe" | "codex-subscribe"
  | "image-gen" | "video-gen" | "tts";

export interface Selection {
  client: string;
  index: number;
}

export interface AnalyticsResponse {
  summary: Record<string, unknown>;
  timeline: unknown[];
  purpose_breakdown: unknown[];
  client_breakdown: unknown[];
  endpoint_breakdown: unknown[];
  model_breakdown: unknown[];
  detail_breakdown: unknown[];
  [key: string]: unknown;
}

export interface CustomPrice {
  model: string;
  currency: string;
  prompt: number;
  completion: number;
  cache_creation?: number;
  cache_read?: number;
}
