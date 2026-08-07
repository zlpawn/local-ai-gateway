---
name: cookie-exporter
description: "导出浏览器 cookie 为 Netscape 格式 cookies.txt，供 yt-dlp 等工具下载需要登录的视频时使用。优先通过网关 + Leo cookie.txt Locally 扩展任务（agent 可创建后有限轮询）；本地读库脚本作离线备用，支持 Chrome、Edge、Brave、Firefox。当用户需要下载需要登录的网页视频、遇到 yt-dlp 报错需要 cookie、或想批量导出浏览器登录态时使用。"
---

# Cookie 导出助手

## 用途

将浏览器 cookie 导出为 Netscape 格式的 `cookies.txt`，供 yt-dlp、wget、curl 等工具使用。

| 路径 | 场景 | 依赖 |
|------|------|------|
| **C. 扩展任务（推荐，agent 可自动）** | 网关在跑，Chrome/Edge/Brave 已装 Leo cookie.txt Locally | 网关 + 扩展在线 |
| **A/B. 扩展 UI** | 人点网关页按钮或扩展弹窗 | 网关 + 扩展 |
| **本地脚本（备用）** | 离线 / Firefox / 无扩展 | Python 3.8+ |

Windows 上 Chrome 开着时本地读库常因文件锁 / app-bound encryption（v20）失败；扩展路径可绕过。

## 推荐路径 C：agent / skill 经网关让插件导出

前提：

1. 网关已启动（默认 `http://127.0.0.1:8788`）
2. 已加载扩展 **Leo cookie.txt Locally ≥ 1.1.0** 并 Reload
3. `GET /v1/extensions/list` 里该扩展 `online: true`

### 创建任务

```bash
curl -s -X POST http://127.0.0.1:8788/v1/cookies/export-via-extension \
  -H 'Content-Type: application/json' \
  -d '{"domain":"bilibili.com"}'
```

成功示例：

```json
{
  "task_id": "etsk_...",
  "status": "queued",
  "poll_after_ms": 2000,
  "max_polls_suggested": 30
}
```

若无在线 cookies 扩展：

```json
{ "error": { "type": "no_online_extension", "message": "..." } }
```

→ 提示用户打开浏览器并加载/重载扩展；不要死等。可再退回本地脚本。

### 有限轮询（必须遵守上限）

- 间隔：`poll_after_ms`（默认 **2000ms**）
- 最大次数：**30**（约 60s）
- **禁止无限轮询**

```bash
# 伪代码
for i in 1..30:
  sleep 2
  curl -s http://127.0.0.1:8788/v1/cookies/export-via-extension/TASK_ID
  # status=succeeded -> 使用 result.file_path
  # status=failed    -> 输出 error.message 并停止
  # status=queued|running -> 继续
# 超过 30 次仍未完成 -> 停止并提示超时
```

成功时使用：

```bash
yt-dlp --cookies "/path/to/cookies-bilibili.com.txt" "<URL>"
```

扩展在后台每约 2s claim 一次任务；**不需要网关网页一直开着**。

### 通用任务总线（扩展性）

Cookie 只是 `type=cookies.export` 的一种。底层通用 API：

- `POST /v1/extension-tasks`
- `GET /v1/extension-tasks/:id`
- `POST /v1/extension-tasks/claim`（扩展用）
- `POST /v1/extension-tasks/:id/complete|fail`（扩展用）

未来新任务类型只需注册 type 插件，不必改 claim/complete 核心。

## 路径 A/B：手动扩展 UI

- **A**：网关「视频知识库 → Cookie 工具」→「用浏览器插件导出」
- **B**：扩展弹窗填域名 →「导出到网关」

## 备用：本地读库脚本

完全独立，不依赖网关。需 Python 3.8+；Chrome 系另需 `pycryptodome`。

### 依赖检查

```bash
python --version || python3 --version
pip install pycryptodome || pip3 install pycryptodome || uv tool install pycryptodome
```

### 用法

```bash
python scripts/export_cookies.py --list-browsers
python scripts/export_cookies.py --browser chrome --list-domains
python scripts/export_cookies.py --browser chrome --domain youtube.com -o cookies.txt
python scripts/export_cookies.py --browser firefox --all -o cookies.txt
```

Windows 上 Chrome 运行中读库失败时，优先改走路径 C。

### 跨平台

| 平台 | Chrome/Edge/Brave | Firefox |
|------|-------------------|---------|
| macOS | Keychain | 明文 |
| Windows | DPAPI；难解 v20 | 明文 |
| Linux | keyring / peanuts | 明文 |

## 选择建议

1. 网关 + 扩展在线 → **路径 C**
2. 人在浏览器前 → A/B 也行
3. 离线 / Firefox / 无扩展 → 本地脚本
4. 导出文件含登录态，权限 0600，勿外传

## 安全说明

- 路径 C：扩展只把指定域名 cookie 发到本机网关（默认 127.0.0.1）
- 本地脚本：只读浏览器文件，不访问网络
- 密钥不落盘；cookies.txt 勿分享
