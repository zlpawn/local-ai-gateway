// Shared helpers for masking secrets returned to UIs/CLIs.
export function maskSecret(value, { keepStart = 6, keepEnd = 4 } = {}) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= keepStart + keepEnd) {
    return `${text.slice(0, 2)}${"*".repeat(Math.max(2, text.length - 2))}`;
  }
  return `${text.slice(0, keepStart)}${"*".repeat(4)}${text.slice(-keepEnd)}`;
}

export function hasValue(value) {
  return Boolean(String(value || "").trim());
}
