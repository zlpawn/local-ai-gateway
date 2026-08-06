const GATEWAY_DEFAULT = "http://127.0.0.1:8788";

document.addEventListener("DOMContentLoaded", async () => {
  const gatewayInput = document.getElementById("gateway-url");
  const domainInput = document.getElementById("domain");
  const exportBtn = document.getElementById("export-btn");
  const resultDiv = document.getElementById("result");

  // Load saved gateway URL
  const stored = await chrome.storage.local.get("gatewayUrl");
  gatewayInput.value = stored.gatewayUrl || GATEWAY_DEFAULT;

  // Save gateway URL on change + trigger re-registration
  gatewayInput.addEventListener("change", async () => {
    const url = gatewayInput.value.trim() || GATEWAY_DEFAULT;
    await chrome.storage.local.set({ gatewayUrl: url });
    resultDiv.textContent = "Shrimp 服务地址已保存";
    setTimeout(() => { resultDiv.textContent = ""; }, 2000);
  });

  // Prefill domain from active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const hostname = new URL(tab.url).hostname;
      // Strip www. prefix for convenience
      const domain = hostname.replace(/^www\./, "");
      domainInput.value = domain;
    }
  } catch {}

  // Export button
  exportBtn.addEventListener("click", async () => {
    const gatewayUrl = (gatewayInput.value || GATEWAY_DEFAULT).trim();
    const domain = domainInput.value.trim();
    if (!domain) {
      resultDiv.innerHTML = '<span class="err">请输入域名</span>';
      return;
    }
    exportBtn.disabled = true;
    exportBtn.textContent = "导出中...";
    resultDiv.textContent = "";
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      if (cookies.length === 0) {
        resultDiv.innerHTML = '<span class="err">未找到该域名的 cookie</span>';
        return;
      }
      const resp = await fetch(`${gatewayUrl}/v1/cookies/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain,
          cookies: cookies.map((c) => ({
            domain: c.domain,
            path: c.path,
            name: c.name,
            value: c.value,
            secure: c.secure,
            httponly: c.httpOnly,
            expires: c.expirationDate || 0,
          })),
        }),
      });
      const data = await resp.json();
      if (resp.ok) {
        resultDiv.innerHTML = `<span class="ok">导出成功: ${data.count} 条 cookie<br>文件: ${data.file_path}</span>`;
      } else {
        resultDiv.innerHTML = `<span class="err">导出失败: ${data.error?.message || "未知错误"}</span>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `<span class="err">无法连接到网关，请检查Shrimp 服务地址</span>`;
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = "导出到网关";
    }
  });
});