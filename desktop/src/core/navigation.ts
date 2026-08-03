import { state } from "./state";
import { render } from "./render";

type TabHooks = { onEnter?: () => void; onLeave?: () => void };

const tabHooks: Record<string, TabHooks> = {};

export function registerTab(tabId: string, hooks: TabHooks): void {
  tabHooks[tabId] = hooks;
}

export function switchTab(tabId: string): void {
  const prevClient = state.activeClient;
  state.activeClient = tabId;

  if (prevClient !== tabId && tabHooks[prevClient]?.onLeave) {
    tabHooks[prevClient].onLeave!();
  }

  if (state.selectedEndpoint && state.selectedEndpoint.client !== tabId) {
    state.selectedEndpoint = null;
  }

  document.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
  const navItem = document.querySelector(`.nav-item[href="#${tabId}"]`);
  if (navItem) navItem.classList.add("active");

  document.querySelectorAll(".tab-section").forEach((el) => {
    (el as HTMLElement).style.display = "none";
    el.classList.remove("active");
  });

  const sectionId = tabId;
  const activeSection = document.getElementById(`section-${sectionId}`);
  if (activeSection) {
    (activeSection as HTMLElement).style.display = "block";
    activeSection.classList.add("active");
  }

  render();

  if (tabHooks[tabId]?.onEnter) {
    tabHooks[tabId].onEnter!();
  }
}
