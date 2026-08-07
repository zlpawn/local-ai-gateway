# Leo cookie.txt Locally

A Chrome/Edge/Brave extension that exports cookies from the browser to the Shrimp gateway.

## Installation

1. Download the zip from the gateway's "浏览器插件" panel (or use this folder).
2. Unzip to a folder if needed.
3. Open `chrome://extensions`.
4. Enable "Developer mode" (top right).
5. Click "Load unpacked" and select the unzipped folder.
6. After upgrading to 1.1.0+, click **Reload** on the extension card.

## Usage

### Via agent / skill (Path C)
1. Ensure the extension is loaded and the gateway is running.
2. Create a task:
   ```bash
   curl -s -X POST http://127.0.0.1:8788/v1/cookies/export-via-extension \
     -H 'Content-Type: application/json' \
     -d '{"domain":"bilibili.com"}'
   ```
3. Poll every 2s, max 30 times:
   ```bash
   curl -s http://127.0.0.1:8788/v1/cookies/export-via-extension/TASK_ID
   ```
4. On `status=succeeded`, use `result.file_path` with yt-dlp.

The extension claims tasks every ~2s while registered. The gateway page does not need to stay open.

### Via popup (Path B)
1. Navigate to the website you want to export cookies from (e.g. bilibili.com).
2. Click the extension icon in the toolbar.
3. The domain is auto-filled from the current tab. Adjust if needed.
4. Click "导出到网关".

### Via gateway page (Path A)
1. Open the gateway's video-kb cookie panel in Chrome.
2. Click "用浏览器插件导出".
3. The extension reads cookies in the background and sends them to the gateway.
