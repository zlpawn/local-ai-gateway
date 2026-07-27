// Antigravity v1internal integration - constants
// Non-sensitive configuration only. OAuth client credentials are NOT hardcoded
// here (GitHub secret scanning would block them); they are read at runtime from
// antigravity.secrets.json (see token-store.mjs), extracted from
// AG-Manager src-tauri/src/modules/oauth.rs:6-9.

// Google OAuth endpoints
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

// OAuth scopes (must match the Antigravity client)
export const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

// Local OAuth callback server
export const REDIRECT_PORT = 8080;
export const REDIRECT_PATH = "/callback";
export function redirectUri(port = REDIRECT_PORT) {
  return `http://localhost:${port}${REDIRECT_PATH}`;
}

// Refresh access token this many seconds before it expires
export const TOKEN_REFRESH_SKEW_SECONDS = 900;

// v1internal upstream base URLs (fallback order: prod -> daily -> sandbox)
export const V1INTERNAL_BASE_URLS = process.env.ANTIGRAVITY_REST_BASE_URL
  ? [process.env.ANTIGRAVITY_REST_BASE_URL]
  : [
      "https://cloudcode-pa.googleapis.com/v1internal",
      "https://daily-cloudcode-pa.googleapis.com/v1internal",
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal",
    ];

// User-Agent for OAuth token requests
export const OAUTH_USER_AGENT = "local-ai-gateway/0.0.3 antigravity";