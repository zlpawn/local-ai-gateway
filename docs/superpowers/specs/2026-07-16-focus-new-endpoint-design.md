# Spec: Focus New Endpoint at Top

## Overview
Improve user experience in the configuration panel by prepending new endpoints at the top of the list and automatically focusing the "Name" input field.

## Proposed Changes

### [desktop/config-panel.html](file:///d:/agent-transfer/desktop/config-panel.html)

1. **Add ID to Name Input**: Update `createEndpointHTML` to add a unique `id="input-name-${client}-${index}"` to the endpoint Name input field.
2. **Use unshift for New Endpoints**: Update `window.addEndpoint` to use `unshift` instead of `push` to prepend the new endpoint object to the client's endpoint list.
3. **Trigger Focus after Render**: Add a `setTimeout` block in `window.addEndpoint` to find `input-name-${client}-0` and call `.focus()` on it immediately after rendering.

## Verification Plan

### Manual Verification
1. Open http://127.0.0.1:8787/config in the browser.
2. Click "Add Endpoint" (新增节点) on any tab (Code / Desktop / Codex).
3. Verify that the new endpoint block is added at the very top (Node 1) and the cursor is automatically focused inside the "Name" input box.
