export function showToast(message: string, type: "success" | "error" | "info" = "success"): void {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  const container = document.getElementById("toast-container") || document.body;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
