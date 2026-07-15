# Focus New Endpoint at Top Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modify the configuration panel UI to prepend new endpoints at the top of the list and automatically focus the "Name" input field.

**Architecture:** Update `desktop/config-panel.html` to add an `id` to the endpoint Name input, use `unshift` instead of `push` when adding a new endpoint, and programmatically trigger `.focus()` on the new input after rendering.

**Tech Stack:** HTML, JavaScript, CSS (Vanilla)

## Global Constraints

- No external npm package additions for frontend styling.
- All modifications must be written to `desktop/config-panel.html`.

---

### Task 1: Update Frontend Config Panel UI

**Files:**
- Modify: `desktop/config-panel.html`

**Interfaces:**
- Consumes: None
- Produces: UI changes for prepending and focusing new endpoints.

- [ ] **Step 1: Add ID to the Name Input Field**

Modify `createEndpointHTML(client, index, ep)` in `desktop/config-panel.html` around line 841:
```html
<div class="form-group">
    <label>名称</label>
    <input type="text" id="input-name-${client}-${index}" value="${ep.name || ''}" placeholder="例如：OpenRouter" onchange="updateEndpoint('${client}', ${index}, 'name', this.value)">
</div>
```

- [ ] **Step 2: Update addEndpoint to Prepend and Focus**

Modify `window.addEndpoint` in `desktop/config-panel.html` around line 951:
```javascript
        window.addEndpoint = function(client) {
            config.clients[client].endpoints = config.clients[client].endpoints || [];
            config.clients[client].endpoints.unshift({
                name: "新服务商",
                type: "anthropic",
                base_url: "",
                api_key: "",
                models: [],
                model_mapping: {}
            });
            render();
            setTimeout(() => {
                const nameInput = document.getElementById(`input-name-${client}-0`);
                if (nameInput) {
                    nameInput.focus();
                    nameInput.select();
                }
            }, 0);
        }
```

- [ ] **Step 3: Manually Verify UI Changes**

Open `http://127.0.0.1:8787/config` in a browser.
Click "Add Endpoint" (新增节点) on any client tab.
Expected: A new "新服务商" node card is added at the top (marked "节点 1"), and the "名称" input field is automatically focused with its text selected.

- [ ] **Step 4: Commit Changes**

```bash
git add desktop/config-panel.html
git commit -m "feat: prepend and focus new endpoint at the top"
```
