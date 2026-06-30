const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gatewayDesktop", {
  getState: () => ipcRenderer.invoke("gateway:get-state"),
  start: () => ipcRenderer.invoke("gateway:start"),
  stop: () => ipcRenderer.invoke("gateway:stop"),
  restart: () => ipcRenderer.invoke("gateway:restart"),
  getModels: () => ipcRenderer.invoke("gateway:get-models"),
  getProviders: () => ipcRenderer.invoke("gateway:get-providers"),
  readConfig: () => ipcRenderer.invoke("config:read"),
  saveConfig: (raw) => ipcRenderer.invoke("config:save", raw),
  readLogs: () => ipcRenderer.invoke("logs:read"),
  openPath: (targetPath) => ipcRenderer.invoke("app:open-path", targetPath),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("gateway:state", listener);
    return () => ipcRenderer.removeListener("gateway:state", listener);
  },
  onLogData: (callback) => {
    const listener = (_event, chunk) => callback(chunk);
    ipcRenderer.on("gateway:log-data", listener);
    return () => ipcRenderer.removeListener("gateway:log-data", listener);
  },
});
