import { state } from "./core/state";
import { getConfig } from "./core/api";
import { render } from "./core/render";
import { switchTab } from "./core/navigation";

// Register window exports needed by inline HTML handlers
window.switchTab = switchTab;

async function init(): Promise<void> {
  const data = await getConfig();
  if (data && data.clients) {
    state.config = { ...state.config, ...data };
  }
  render();
}

document.addEventListener("DOMContentLoaded", () => {
  init();
});

console.log("panel loaded with core modules");
