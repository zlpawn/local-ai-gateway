const api = window.gatewayDesktop;

const state = {
  currentView: "status",
  currentLog: "gateway",
  logs: {
    gateway: "",
    stdout: "",
    stderr: "",
  },
};

const elements = {
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  baseUrl: document.querySelector("#baseUrl"),
  baseUrlFoot: document.querySelector("#baseUrlFoot"),
  metricGateway: document.querySelector("#metricGateway"),
  metricPid: document.querySelector("#metricPid"),
  metricPort: document.querySelector("#metricPort"),
  metricUpstream: document.querySelector("#metricUpstream"),
  healthOutput: document.querySelector("#healthOutput"),
  modelsTable: document.querySelector("#modelsTable"),
  providersOutput: document.querySelector("#providersOutput"),
  configEditor: document.querySelector("#configEditor"),
  configStatus: document.querySelector("#configStatus"),
  logOutput: document.querySelector("#logOutput"),
  desktopUrl: document.querySelector("#desktopUrl"),
  codeUrl: document.querySelector("#codeUrl"),
  codexUrl: document.querySelector("#codexUrl"),
  openaiUrl: document.querySelector("#openaiUrl"),
};

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => selectView(button.dataset.view));
});

document.querySelector("#refreshButton").addEventListener("click", refreshAll);
document.querySelector("#startButton").addEventListener("click", () => runAction(api.start));
document.querySelector("#stopButton").addEventListener("click", () => runAction(api.stop));
document.querySelector("#restartButton").addEventListener("click", () => runAction(api.restart));
document.querySelector("#loadModelsButton").addEventListener("click", loadModels);
document.querySelector("#loadProvidersButton").addEventListener("click", loadProviders);
document.querySelector("#loadConfigButton").addEventListener("click", loadConfig);
document.querySelector("#saveConfigButton").addEventListener("click", saveConfig);
document.querySelector("#loadLogsButton").addEventListener("click", loadLogs);
document.querySelector("#openRootButton").addEventListener("click", async () => {
  const current = await api.getState();
  await api.openPath(current.root);
});

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.currentLog = button.dataset.log;
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === button));
    renderLog();
  });
});

api.onState(renderState);
api.onLogData((chunk) => {
  const key = chunk.stream === "gateway.stderr.log" ? "stderr" : "stdout";
  state.logs[key] = `${state.logs[key]}${chunk.text}`.slice(-120000);
  if (state.currentLog === key) renderLog();
});

refreshAll();
setInterval(refreshState, 5000);

function selectView(view) {
  state.currentView = view;
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `view-${view}`);
  });

  if (view === "models") {
    loadModels();
    loadProviders();
  }
  if (view === "config" && !elements.configEditor.value) loadConfig();
  if (view === "logs") loadLogs();
}

async function refreshAll() {
  await refreshState();
  if (state.currentView === "models") {
    await loadModels();
    await loadProviders();
  }
  if (state.currentView === "config") await loadConfig();
  if (state.currentView === "logs") await loadLogs();
}

async function refreshState() {
  try {
    renderState(await api.getState());
  } catch (error) {
    renderError(error);
  }
}

async function runAction(action) {
  setBusy(true);
  try {
    renderState(await action());
  } catch (error) {
    renderError(error);
  } finally {
    setBusy(false);
  }
}

function renderState(gatewayState) {
  const healthy = Boolean(gatewayState.health?.ok);
  elements.statusDot.classList.toggle("ok", healthy);
  elements.statusDot.classList.toggle("error", !healthy);
  elements.statusText.textContent = healthy ? "Gateway online" : "Gateway offline";
  elements.baseUrl.textContent = gatewayState.baseUrl;
  elements.baseUrlFoot.textContent = gatewayState.baseUrl;
  elements.metricGateway.textContent = healthy ? "Online" : gatewayState.running ? "Starting" : "Offline";
  elements.metricPid.textContent = gatewayState.pid || "-";
  elements.metricPort.textContent = String(gatewayState.port);
  elements.metricUpstream.textContent = gatewayState.health?.upstream || "-";
  elements.healthOutput.textContent = JSON.stringify(
    {
      root: gatewayState.root,
      health: gatewayState.health,
      healthError: gatewayState.healthError,
      lastExit: gatewayState.lastExit,
    },
    null,
    2,
  );

  elements.desktopUrl.textContent = `${gatewayState.baseUrl}/desktop`;
  elements.codeUrl.textContent = `${gatewayState.baseUrl}/code`;
  elements.codexUrl.textContent = `${gatewayState.baseUrl}/codex`;
  elements.openaiUrl.textContent = gatewayState.baseUrl;
}

async function loadModels() {
  elements.modelsTable.textContent = "Loading...";
  try {
    const models = await api.getModels();
    renderModels(models.data || models.models || []);
  } catch (error) {
    elements.modelsTable.textContent = error.message;
  }
}

function renderModels(models) {
  elements.modelsTable.replaceChildren();
  elements.modelsTable.append(createRow(["Model", "Owned by", "Object"], true));

  if (!models.length) {
    elements.modelsTable.append(createRow(["No models returned", "-", "-"], false));
    return;
  }

  for (const model of models) {
    elements.modelsTable.append(
      createRow([model.id || model.name || "-", model.owned_by || model.provider || "-", model.object || "model"], false),
    );
  }
}

function createRow(cells, header) {
  const row = document.createElement("div");
  row.className = `table-row${header ? " header" : ""}`;
  for (const value of cells) {
    const cell = document.createElement("div");
    cell.className = "table-cell";
    cell.textContent = String(value);
    cell.title = String(value);
    row.append(cell);
  }
  return row;
}

async function loadProviders() {
  elements.providersOutput.textContent = "Loading...";
  try {
    const providers = await api.getProviders();
    elements.providersOutput.textContent = JSON.stringify(providers, null, 2);
  } catch (error) {
    elements.providersOutput.textContent = error.message;
  }
}

async function loadConfig() {
  setConfigMessage("Loading...", "");
  try {
    const config = await api.readConfig();
    elements.configEditor.value = config.raw;
    setConfigMessage(`Loaded ${config.filePath}`, "ok");
  } catch (error) {
    setConfigMessage(error.message, "error");
  }
}

async function saveConfig() {
  setConfigMessage("Saving...", "");
  try {
    await api.saveConfig(elements.configEditor.value);
    setConfigMessage("Saved. Restart the gateway to apply config changes.", "ok");
  } catch (error) {
    setConfigMessage(error.message, "error");
  }
}

function setConfigMessage(text, type) {
  elements.configStatus.textContent = text;
  elements.configStatus.classList.toggle("ok", type === "ok");
  elements.configStatus.classList.toggle("error", type === "error");
}

async function loadLogs() {
  try {
    state.logs = await api.readLogs();
    renderLog();
  } catch (error) {
    elements.logOutput.textContent = error.message;
  }
}

function renderLog() {
  elements.logOutput.textContent = state.logs[state.currentLog] || "";
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function setBusy(busy) {
  document.querySelectorAll(".actions button").forEach((button) => {
    button.disabled = busy;
  });
}

function renderError(error) {
  elements.statusDot.classList.remove("ok");
  elements.statusDot.classList.add("error");
  elements.statusText.textContent = error.message;
}


