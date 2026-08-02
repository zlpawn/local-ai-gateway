# System Expansion Design Spec: Usage Analytics & Network Proxy Tabs

## Overview

This specification introduces two new navigation tabs and backend services to the Gateway system:
1. **用量统计 (Token Analytics)**: A disk-persisted (`node:sqlite`) usage monitoring tab providing minute, hourly, and daily breakdown charts and filters by node purpose (Chat, Embedding, Image Generation, Video Generation), client, and model.
2. **网络代理 (Network Proxy)**: A centralized proxy management tab allowing global HTTP/HTTPS/SOCKS5 proxy configuration, live connection testing, and per-endpoint override controls.

Both features adhere to the **Open-Closed Principle (OCP)**: existing endpoint routes and streaming lifecycles remain intact while decoupled modules subscribe to request completions and resolve outbound proxies.

---

## 1. Tab Naming & Navigation

All primary navigation tab labels use a clean 4-character format:
- **用量统计** (`#analytics`): Token usage dashboard and interactive timeline charts.
- **网络代理** (`#proxy`): Global proxy configuration, connectivity probe, and endpoint routing status.

---

## 2. Token Analytics (用量统计) Architecture

### 2.1 Storage Layer (`node:sqlite`)
Using Node.js native `node:sqlite` (`DatabaseSync`), usage logs are persisted in `gateway.db` at the project root.

#### Schema (`token_usage_logs`)
```sql
CREATE TABLE IF NOT EXISTS token_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,            -- Unix timestamp (ms)
  date_str TEXT NOT NULL,                -- YYYY-MM-DD
  hour_str TEXT NOT NULL,                -- YYYY-MM-DD HH:00
  minute_str TEXT NOT NULL,              -- YYYY-MM-DD HH:mm
  client TEXT NOT NULL,                  -- codex, desktop, code, deeptutor, etc.
  endpoint_id TEXT NOT NULL,             -- ep_...
  endpoint_name TEXT NOT NULL,           -- huoshan-agentplan, etc.
  purpose TEXT NOT NULL,                 -- chat, embedding, image_generation, video_generation, tts
  model TEXT NOT NULL,                   -- doubao-seed-2.0-pro, glm-5.2, etc.
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON token_usage_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_date ON token_usage_logs(date_str);
CREATE INDEX IF NOT EXISTS idx_logs_hour ON token_usage_logs(hour_str);
CREATE INDEX IF NOT EXISTS idx_logs_minute ON token_usage_logs(minute_str);
CREATE INDEX IF NOT EXISTS idx_logs_purpose ON token_usage_logs(purpose);
```

### 2.2 Decoupled Logging Pipeline (OCP)
A dedicated `TokenTrackerService` (`lib/analytics/token-tracker.mjs`) exposes a `recordUsage(params)` method. Gateway completion hooks (ResponsesWriter finish event, Chat adapter completion, Embedding tool response, Media generator output) emit usage without changing routing logic.

### 2.3 Analytics API
- **Endpoint**: `GET /v1/analytics/token-usage`
- **Parameters**:
  - `granularity`: `minute` | `hour` | `day` (default: `hour`)
  - `range`: `1h` | `24h` | `7d` | `30d` (default: `24h`)
  - `purpose`: `all` | `chat` | `embedding` | `image_generation` | `video_generation` | `tts`
  - `client`: optional filter
  - `model`: optional filter
- **Response**: Aggregated summary cards (Total Tokens, Prompt Tokens, Completion Tokens, Total Requests) and time-series points for charts.

### 2.4 UI Features
- **Stat Summary Cards**: Total Tokens, Input Tokens, Output Tokens, Total Requests.
- **Controls**:
  - Granularity switcher (分钟 / 小时 / 天)
  - Time range switcher (1小时 / 24小时 / 7天 / 30天)
  - Node Purpose filter (全部节点 / 聊天节点 / 向量节点 / 视频生成节点 / 图像生成节点 / 语音节点)
- **Interactive SVG Chart**: Responsive multi-series bar/line timeline visualization.

---

## 3. Network Proxy (网络代理) Architecture

### 3.1 Proxy Configuration Schema
Persisted inside `gateway.config.json` under `server.proxy`:
```json
{
  "server": {
    "proxy": {
      "enabled": true,
      "protocol": "http",
      "host": "127.0.0.1",
      "port": 7897,
      "username": "",
      "password": ""
    }
  }
}
```

### 3.2 Extensible Proxy Resolver (`lib/config/proxy-resolver.mjs`)
Proxy resolution priority:
1. **Endpoint explicit override `proxy_mode: "disabled"`** $\to$ Direct connection (no proxy).
2. **Endpoint explicit override `proxy_mode: "custom"`** $\to$ Use endpoint's custom proxy settings.
3. **Global fallback (default)** $\to$ If `server.proxy.enabled` is true, build proxy URL/agent from global configuration; otherwise direct.

### 3.3 Proxy APIs
- `GET /v1/config/proxy`: Fetch global proxy configuration.
- `POST /v1/config/proxy`: Update global proxy configuration and apply immediately.
- `POST /v1/config/proxy/test`: Test proxy connectivity by probing upstream target (e.g. `https://api.openai.com` or `https://cli-chat-proxy.grok.com`) and returning RTT latency and status.

### 3.4 UI Features
- **Global Proxy Form**: Switch, Protocol selector (`http`, `https`, `socks5`), Host/IP, Port, optional Auth.
- **Test Button (测试连通性)**: Probes connectivity and displays RTT latency.
- **Endpoint Status Table**: Overview of all configured endpoints and their active proxy mode (全局代理 / 节点独立代理 / 直连).

---

## 4. Verification & Testing

- Unit tests for `node:sqlite` token logging and timeline aggregation queries.
- Unit tests for proxy resolution logic and endpoint overrides.
- Integration tests for `/v1/analytics/token-usage` and `/v1/config/proxy` endpoints.
- Config panel UI rendering tests for both tabs.
